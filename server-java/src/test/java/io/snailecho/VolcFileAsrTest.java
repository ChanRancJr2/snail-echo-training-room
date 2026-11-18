package io.snailecho;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class VolcFileAsrTest {
    private static final String AUDIO_ID = "091b4493-06b3-4626-a432-37ea806c8d1e";
    private static final String VENDOR_ID = "619e44bb-e0d7-4b61-b091-97b8a6c828ab";
    private static final String TEMP_URL = "https://media.example.invalid/private.mp3?signature=placeholder";
    private final ObjectMapper json = new ObjectMapper();
    private HttpServer server;
    private VolcFileAsr client;

    @BeforeEach void start() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.start();
        client = new VolcFileAsr(HttpClient.newHttpClient(), json,
                URI.create("http://127.0.0.1:" + server.getAddress().getPort() + "/"), "fake-test-key",
                "volc.seedasr.auc", Duration.ofSeconds(2));
    }

    @AfterEach void stop() {
        server.stop(0);
    }

    @Test void submitsOneSignedMp3AndQueriesWithTheReturnedTaskId() throws Exception {
        var submittedBody = new AtomicReference<String>();
        var submittedId = new AtomicReference<String>();
        var sequence = new AtomicReference<String>();
        var calls = new AtomicInteger();
        server.createContext("/submit", exchange -> {
            submittedBody.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            submittedId.set(exchange.getRequestHeaders().getFirst("X-Api-Request-Id"));
            sequence.set(exchange.getRequestHeaders().getFirst("X-Api-Sequence"));
            reply(exchange, 200, "20000000", "{\"task_id\":\"" + VENDOR_ID + "\"}");
        });
        server.createContext("/query", exchange -> {
            String id = exchange.getRequestHeaders().getFirst("X-Api-Request-Id");
            if (!VENDOR_ID.equals(id) || !"fake-test-key".equals(exchange.getRequestHeaders().getFirst("X-Api-Key"))) {
                reply(exchange, 403, "45000000", "{}");
                return;
            }
            if (calls.incrementAndGet() == 1) reply(exchange, 200, "20000002", "{}");
            else reply(exchange, 200, "20000000", "{\"result\":{\"text\":\"这是转写。\"}}");
        });

        assertThat(client.submit(AUDIO_ID, TEMP_URL)).isEqualTo(VENDOR_ID);
        assertThat(submittedId.get()).isEqualTo(AUDIO_ID);
        assertThat(sequence.get()).isEqualTo("-1");
        assertThat(json.readTree(submittedBody.get()).at("/audio/url").asText()).isEqualTo(TEMP_URL);
        assertThat(json.readTree(submittedBody.get()).at("/audio/format").asText()).isEqualTo("mp3");
        assertThat(client.query(VENDOR_ID).pending()).isTrue();
        assertThat(client.query(VENDOR_ID).text()).isEqualTo("这是转写。");
        assertThat(calls).hasValue(2);
    }

    @Test void handlesSilenceAndDoesNotIncludeUpstreamResponseOrCredentialsInErrors() {
        server.createContext("/query", exchange -> reply(exchange, 200, "20000003", "{}"));
        server.createContext("/submit", exchange -> reply(exchange, 403, "45000000", TEMP_URL + " fake-test-key"));
        assertThat(client.query(VENDOR_ID).text()).isEmpty();
        assertThatThrownBy(() -> client.submit(AUDIO_ID, TEMP_URL))
                .isInstanceOf(AsrFailure.class).hasMessage("VOLC_SUBMIT_REJECTED")
                .hasNoCause();
    }

    @Test void preservesTheClientIdWhenAnAcceptedSubmissionHasAnUnreadableBody() {
        server.createContext("/submit", exchange -> reply(exchange, 200, "20000000", "{invalid"));
        assertThat(client.submit(AUDIO_ID, TEMP_URL)).isEqualTo(AUDIO_ID);
    }

    private static void reply(HttpExchange exchange, int status, String asrStatus, String body) throws IOException {
        try (exchange) {
            exchange.getResponseHeaders().set("X-Api-Status-Code", asrStatus);
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(status, bytes.length);
            exchange.getResponseBody().write(bytes);
        }
    }
}
