package io.snailecho;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.regex.Pattern;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

final class VolcFileAsr {
    private static final int MAX_RESPONSE_BYTES = 512 * 1024;
    private static final int MAX_TRANSCRIPT_CHARS = 12000;
    private static final Pattern TASK_ID = Pattern.compile("[a-zA-Z0-9_-]{1,128}");
    private final HttpClient http;
    private final ObjectMapper json;
    private final URI endpoint;
    private final String key;
    private final String resource;
    private final Duration timeout;

    record Query(boolean pending, String text) {}
    private record Reply(int httpStatus, String code, byte[] body) {
        boolean ok() { return httpStatus >= 200 && httpStatus < 300; }
        boolean retryable() {
            return httpStatus == 429 || httpStatus >= 500 || code.equals("55000000")
                    || code.equals("55000001") || code.equals("55000031");
        }
    }

    VolcFileAsr(HttpClient http, ObjectMapper json, URI endpoint, String key, String resource, Duration timeout) {
        this.http = http;
        this.json = json;
        this.endpoint = endpoint;
        this.key = key;
        this.resource = resource;
        this.timeout = timeout;
    }

    String submit(String requestId, String signedMp3Url) {
        String body;
        try {
            body = json.writeValueAsString(Map.of(
                    "audio", Map.of("url", signedMp3Url, "format", "mp3", "rate", 16000, "channel", 1),
                    "request", Map.of("model_name", "bigmodel", "enable_punc", true,
                            "enable_itn", false, "enable_ddc", false, "show_utterances", false)));
        } catch (JsonProcessingException invalid) {
            throw new AsrFailure("VOLC_INVALID_REQUEST", false);
        }
        var reply = send("submit", requestId, body, true);
        if (!reply.ok() || !"20000000".equals(reply.code())) {
            throw new AsrFailure("VOLC_SUBMIT_REJECTED", reply.retryable() || "45000001".equals(reply.code()));
        }
        if (reply.body().length > 0) {
            try {
                var task = parse(reply).path("task_id");
                if (task.isTextual() && TASK_ID.matcher(task.textValue()).matches()) return task.textValue();
            } catch (AsrFailure unreadableAcknowledgement) {
                // Acceptance is authoritative. Reconcile using the original request ID.
            }
        }
        return requestId;
    }

    Query query(String taskId) {
        var reply = send("query", taskId, "{}", false);
        if (reply.ok()) {
            switch (reply.code()) {
                case "20000001", "20000002": return new Query(true, null);
                case "20000003": return new Query(false, "");
                case "20000000":
                    var text = parse(reply).path("result").path("text");
                    if (!text.isTextual() || text.textValue().length() > MAX_TRANSCRIPT_CHARS) {
                        throw new AsrFailure("VOLC_INVALID_RESPONSE", false);
                    }
                    return new Query(false, text.textValue());
                default: break;
            }
        }
        throw new AsrFailure("VOLC_QUERY_REJECTED", reply.retryable());
    }

    private JsonNode parse(Reply reply) {
        try {
            JsonNode result = json.readTree(reply.body());
            if (result != null && result.isObject()) return result;
        } catch (IOException invalid) {
            // Preserve only the local error code.
        }
        throw new AsrFailure("VOLC_INVALID_RESPONSE", false);
    }

    private Reply send(String route, String taskId, String body, boolean submit) {
        if (!TASK_ID.matcher(taskId).matches()) throw new AsrFailure("VOLC_INVALID_TASK_ID", false);
        var request = HttpRequest.newBuilder(endpoint.resolve(route)).timeout(timeout)
                .header("X-Api-Key", key).header("X-Api-Resource-Id", resource)
                .header("X-Api-Request-Id", taskId).header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body));
        if (submit) request.header("X-Api-Sequence", "-1");
        var bytes = new ByteArrayOutputStream();
        var response = http.sendAsync(request.build(), info -> HttpResponse.BodySubscribers.ofByteArrayConsumer(chunk ->
                chunk.ifPresent(value -> {
                    if (value.length > MAX_RESPONSE_BYTES - bytes.size()) {
                        throw new AsrFailure("VOLC_RESPONSE_TOO_LARGE", false);
                    }
                    bytes.writeBytes(value);
                })));
        try {
            var result = response.get(timeout.toMillis(), TimeUnit.MILLISECONDS);
            return new Reply(result.statusCode(), result.headers().firstValue("X-Api-Status-Code").orElse(""),
                    bytes.toByteArray());
        } catch (InterruptedException interrupted) {
            response.cancel(true);
            Thread.currentThread().interrupt();
            throw new AsrFailure("VOLC_INTERRUPTED", true);
        } catch (TimeoutException timeoutFailure) {
            response.cancel(true);
            throw new AsrFailure("VOLC_TIMEOUT", true);
        } catch (ExecutionException networkFailure) {
            if (networkFailure.getCause() instanceof AsrFailure failure) {
                throw new AsrFailure(failure.getMessage(), submit);
            }
            throw new AsrFailure("VOLC_UNAVAILABLE", true);
        }
    }
}
