package io.snailecho;

import java.io.ByteArrayOutputStream;
import java.net.http.HttpClient;
import java.net.http.HttpHeaders;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

final class ProviderHttp {
    record Response(int status, HttpHeaders headers, byte[] body) {}
    static final class ResponseTooLarge extends RuntimeException {}

    private ProviderHttp() {}

    static Response send(HttpClient http, HttpRequest request, Duration timeout, int limit)
            throws InterruptedException, TimeoutException, ExecutionException {
        var bytes = new ByteArrayOutputStream();
        var pending = http.sendAsync(request, ignored -> HttpResponse.BodySubscribers.ofByteArrayConsumer(chunk ->
                chunk.ifPresent(value -> {
                    if (value.length > limit - bytes.size()) throw new ResponseTooLarge();
                    bytes.writeBytes(value);
                })));
        try {
            var reply = pending.get(timeout.toMillis(), TimeUnit.MILLISECONDS);
            return new Response(reply.statusCode(), reply.headers(), bytes.toByteArray());
        } catch (InterruptedException | TimeoutException incomplete) {
            pending.cancel(true);
            throw incomplete;
        }
    }
}
