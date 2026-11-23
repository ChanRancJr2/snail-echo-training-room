package io.snailecho;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ArkComparisonTest {
    private final ObjectMapper json = new ObjectMapper();
    private HttpServer server;
    private ArkComparison ark;
    private final List<ArkComparison.Point> points = List.of(
            new ArkComparison.Point("a", "事件", "周六先看望外婆，再决定是否聚餐"),
            new ArkComparison.Point("b", "时间", "周六上午十点到"));

    @BeforeEach void open() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.start();
        ark = new ArkComparison(HttpClient.newHttpClient(), json,
                URI.create("http://127.0.0.1:" + server.getAddress().getPort() + "/compare"),
                "fake-review-key", "fake-endpoint", Duration.ofSeconds(2));
    }

    @AfterEach void close() {
        server.stop(0);
        ark.close();
    }

    @Test void preservesIndependentDecisionsOnlyWithQuotesFromTheTranscript() {
        JsonNode[] request = new JsonNode[1];
        var authorization = new AtomicReference<String>();
        respond(200, modelResponse(List.of(
                item("a", false, true, "周六先去看外婆", "理解不到位"),
                item("b", true, false, "周六上午九点到", "理解偏了"))), request, authorization);

        var answer = ark.compare(points, "周六先去看外婆。周六上午九点到。");
        assertThat(answer.get("a").complete()).isFalse();
        assertThat(answer.get("a").accurate()).isTrue();
        assertThat(answer.get("b").complete()).isTrue();
        assertThat(answer.get("b").accurate()).isFalse();
        assertThat(answer.get("b").listenerQuote()).isEqualTo("周六上午九点到");
        assertThat(authorization.get()).isEqualTo("Bearer fake-review-key");
        assertThat(request[0].at("/response_format/type").asText()).isEqualTo("json_object");
        assertThat(request[0].at("/messages/0/role").asText()).isEqualTo("system");
        assertThat(request[0].at("/messages/1/content").asText()).contains("周六先去看外婆");
    }

    @Test void extractsOnlyGroundedSpeakerPoints() throws IOException {
        JsonNode[] request = new JsonNode[1];
        String content = json.writeValueAsString(Map.of("points", List.of(
                Map.of("category", "时间", "text", "周六上午十点", "sourceQuote", "周六上午十点出发"),
                Map.of("category", "事件", "text", "看望外婆", "sourceQuote", "去看望外婆"),
                Map.of("category", "需求", "text", "预订餐厅", "sourceQuote", "预订餐厅"))));
        respond(200, json.writeValueAsString(Map.of("choices", List.of(
                Map.of("finish_reason", "stop", "message", Map.of("content", content))))), request, null);

        var extracted = ark.extract("周六上午十点出发，去看望外婆。");
        assertThat(extracted).containsExactly(new PointService.Point("时间", "周六上午十点"),
                new PointService.Point("事件", "看望外婆"));
        assertThat(request[0].at("/messages/1/content").asText()).contains("周六上午十点出发");
    }

    @Test void extractsVerbatimPointsWithoutASecondModelQuote() throws IOException {
        String content = json.writeValueAsString(Map.of("points", List.of(
                Map.of("category", "时间", "text", "周六上午出发"),
                Map.of("category", "需求", "text", "订餐厅"),
                Map.of("category", "因果", "text", "如果下雨，我们就坐地铁"))));
        respond(200, json.writeValueAsString(Map.of("choices", List.of(
                Map.of("finish_reason", "stop", "message", Map.of("content", content))))), null, null);

        assertThat(ark.extract("周六上午出发。如果下雨，我们就坐地铁。")).containsExactly(
                new PointService.Point("时间", "周六上午出发"),
                new PointService.Point("因果", "如果下雨，我们就坐地铁"));
    }

    @Test void rewriteUsesOnlyKnownEvidenceForTheRequestedRoles() throws IOException {
        var entries = List.of(new ArkComparison.CoachingEvidence("point-a", "先核对价格，再发报价。", "把报价发过去。",
                "misunderstanding"));
        String content = json.writeValueAsString(Map.of("suggestions", List.of(
                Map.of("role", "listener", "evidenceId", "point-a", "text", "复述时先说核对价格，再说发送报价。"),
                Map.of("role", "speaker", "evidenceId", "invented", "text", "建议增加新的条件。"))));
        respond(200, json.writeValueAsString(Map.of("choices", List.of(
                Map.of("finish_reason", "stop", "message", Map.of("content", content))))), null, null);
        assertThat(ark.rewrite(entries, List.of("speaker", "listener")))
                .containsOnlyKeys("listener");
    }

    @Test void ignoresAnInventedQuoteAndLeavesMissingPointsForLocalFallback() {
        respond(200, modelResponse(List.of(item("a", true, true, "凭空捏造", ""))), null, null);
        assertThat(ark.compare(points, "周六先去看外婆。")).isEmpty();
    }

    @Test void rejectsDuplicatePointIdentifiers() {
        var item = item("a", false, true, "看外婆", "理解不到位");
        respond(200, modelResponse(List.of(item, item)), null, null);
        assertThatThrownBy(() -> ark.compare(points, "看外婆。"))
                .isInstanceOf(ArkComparison.Failure.class).hasMessage("ARK_INVALID_RESPONSE");
    }

    @Test void rejectsUnexpectedFieldsAndScalarCoercion() {
        Map<String, Object> item = Map.of("id", "a", "complete", "true", "accurate", false,
                "listenerQuote", "看外婆", "tag", "理解偏了", "clarification", "");
        respond(200, modelResponse(List.of(item)), null, null);
        assertThatThrownBy(() -> ark.compare(points, "看外婆。"))
                .isInstanceOf(ArkComparison.Failure.class).hasMessage("ARK_INVALID_RESPONSE").hasNoCause();
    }

    @Test void sanitizesVendorFailures() {
        respond(503, "secret-body fake-review-key", null, null);
        assertThatThrownBy(() -> ark.compare(points, "看外婆。"))
                .isInstanceOfSatisfying(ArkComparison.Failure.class, failure -> {
                    assertThat(failure.retryable()).isTrue();
                    assertThat(failure.getMessage()).isEqualTo("ARK_HTTP_FAILED");
                    assertThat(failure.getCause()).isNull();
                });
    }

    @Test void directProviderCallsRetryOnceForTemporaryFailuresAndRejectInvalidResponses() {
        var attempts = new AtomicInteger();
        String content = modelResponse(List.of(item("a", true, true, "看外婆", "")));
        server.createContext("/compare", exchange -> {
            try (exchange) {
                int attempt = attempts.incrementAndGet();
                byte[] response = (attempt == 2 ? content : "{}").getBytes(StandardCharsets.UTF_8);
                exchange.sendResponseHeaders(attempt == 1 ? 503 : 200, response.length);
                exchange.getResponseBody().write(response);
            }
        });
        assertThat(ArkComparison.retryTransient(() -> ark.compare(points, "看外婆。"))).containsOnlyKeys("a");
        assertThat(attempts.get()).isEqualTo(2);
        assertThatThrownBy(() -> ArkComparison.retryTransient(() -> ark.compare(points, "看外婆。")))
                .isInstanceOf(ArkComparison.Failure.class).hasMessage("ARK_INVALID_RESPONSE");
        assertThat(attempts.get()).isEqualTo(3);
    }

    @Test void rejectsOversizedResponsesBeforeParsingThem() {
        respond(200, "x".repeat(256 * 1024), null, null);
        assertThatThrownBy(() -> ark.compare(points, "看外婆。"))
                .isInstanceOfSatisfying(ArkComparison.Failure.class, failure -> {
                    assertThat(failure.getMessage()).isEqualTo("ARK_INVALID_RESPONSE");
                    assertThat(failure.retryable()).isFalse();
                });
    }

    @Test void timesOutAfterHeadersWhenTheResponseBodyStalls() {
        var sentHeader = new CountDownLatch(1);
        var unblock = new CountDownLatch(1);
        server.createContext("/compare", exchange -> {
            try (exchange) {
                exchange.sendResponseHeaders(200, 1024);
                exchange.getResponseBody().write('{');
                exchange.getResponseBody().flush();
                sentHeader.countDown();
                unblock.await(5, TimeUnit.SECONDS);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
        });
        var endpoint = URI.create("http://127.0.0.1:" + server.getAddress().getPort() + "/compare");
        try (var bounded = new ArkComparison(HttpClient.newHttpClient(), json, endpoint, "test-key", "test-ep",
                Duration.ofMillis(800))) {
            assertThatThrownBy(() -> bounded.compare(points, "看外婆。"))
                    .isInstanceOf(ArkComparison.Failure.class).hasMessage("ARK_TIMEOUT");
            assertThat(sentHeader.getCount()).isZero();
        } finally {
            unblock.countDown();
        }
    }

    private Map<String, Object> item(String id, boolean complete, boolean accurate, String quote, String tag) {
        return Map.of("id", id, "complete", complete, "accurate", accurate, "listenerQuote", quote,
                "tag", tag, "clarification", "");
    }

    private String modelResponse(List<? extends Map<String, Object>> items) {
        try {
            String content = json.writeValueAsString(Map.of("items", items));
            return json.writeValueAsString(Map.of("choices", List.of(
                    Map.of("finish_reason", "stop", "message", Map.of("content", content)))));
        } catch (IOException invalidFixture) {
            throw new AssertionError(invalidFixture);
        }
    }

    private void respond(int status, String body, JsonNode[] request, AtomicReference<String> authorization) {
        server.createContext("/compare", exchange -> {
            try (exchange) {
                if (request != null) request[0] = json.readTree(exchange.getRequestBody());
                if (authorization != null) authorization.set(exchange.getRequestHeaders().getFirst("Authorization"));
                byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
                exchange.sendResponseHeaders(status, bytes.length);
                exchange.getResponseBody().write(bytes);
            }
        });
    }
}
