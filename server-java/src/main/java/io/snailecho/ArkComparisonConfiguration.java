package io.snailecho;

import java.net.URI;
import java.net.http.HttpClient;
import java.time.Duration;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration(proxyBeanMethods = false)
@ConditionalOnProperty(name = "echo.processing.enabled", havingValue = "true")
class ArkComparisonConfiguration {
    @Bean(destroyMethod = "shutdownNow")
    ExecutorService arkComparisonExecutor() {
        return Executors.newFixedThreadPool(ComparisonWorker.CONCURRENT_PROVIDER_CALLS,
                Thread.ofPlatform().name("echo-ark-", 0).factory());
    }

    @Bean(destroyMethod = "close")
    @ConditionalOnProperty(name = "echo.processing.comparison-mode", havingValue = "ark")
    ArkComparison arkComparison(ObjectMapper json,
            @Value("${echo.processing.ark-api-key}") String key,
            @Value("${echo.processing.ark-model-id}") String model) {
        if (key.isBlank() || model.isBlank()) throw new IllegalStateException("Configure ARK_API_KEY and ARK_MODEL_ID");
        var http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3))
                .followRedirects(HttpClient.Redirect.NEVER).build();
        return new ArkComparison(http, json, URI.create("https://ark.cn-beijing.volces.com/api/v3/chat/completions"),
                key, model, Duration.ofSeconds(ArkComparison.REQUEST_SECONDS));
    }
}
