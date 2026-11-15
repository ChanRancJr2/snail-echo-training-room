package io.snailecho;

import java.net.URI;
import java.net.http.HttpClient;
import java.time.Duration;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration(proxyBeanMethods = false)
@ConditionalOnProperty(name = "echo.processing.enabled", havingValue = "true")
class VolcTranscriptionConfiguration {
    @Bean(destroyMethod = "shutdownNow")
    @ConditionalOnProperty(name = "echo.processing.mode", havingValue = "volc")
    HttpClient speechHttpClient() {
        return HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3))
                .followRedirects(HttpClient.Redirect.NEVER).build();
    }

    @Bean
    @ConditionalOnProperty(name = "echo.processing.mode", havingValue = "volc")
    VolcTranscription volcTranscription(TranscriptionQueue queue, S3AudioStorage storage,
            ObjectMapper json, HttpClient speechHttpClient, @Value("${echo.processing.speech-api-key}") String key,
            @Value("${echo.processing.speech-resource-id}") String resource, @Value("${echo.processing.ffmpeg-path}") String path) {
        if (key.isBlank() || resource.isBlank()) throw new IllegalStateException("Configure SPEECH_API_KEY and SPEECH_RESOURCE_ID");
        if (!storage.hasHttpsEndpoint()) throw new IllegalStateException("Configure an HTTPS object endpoint for file ASR");
        var ffmpeg = new FfmpegAudio(path, Duration.ofSeconds(20));
        var provider = new VolcFileAsr(speechHttpClient, json,
                URI.create("https://openspeech.bytedance.com/api/v3/auc/bigmodel/"), key, resource, Duration.ofSeconds(8));
        return new VolcTranscription(queue, storage, ffmpeg, provider);
    }
}
