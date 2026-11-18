package io.snailecho;

import java.util.Optional;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Component
@ConditionalOnProperty(name = "echo.processing.enabled", havingValue = "true")
class TranscriptionWorker {
    private static final Logger LOG = LoggerFactory.getLogger(TranscriptionWorker.class);
    private final TranscriptionQueue queue;
    private final Optional<VolcTranscription> volc;

    TranscriptionWorker(TranscriptionQueue queue, Optional<VolcTranscription> volc,
                        @Value("${echo.processing.mode:}") String mode) {
        if (!"mock".equals(mode) && !("volc".equals(mode) && volc.isPresent())) {
            throw new IllegalStateException("Set JAVA_TRANSCRIPTION_MODE to mock or volc");
        }
        this.queue = queue;
        this.volc = volc;
    }

    @Scheduled(fixedDelayString = "${echo.processing.worker-delay-ms:1000}",
            initialDelayString = "${echo.processing.worker-delay-ms:1000}")
    public void runOne() {
        var lease = queue.claim(volc.isPresent() ? "volc" : "mock");
        if (lease == null) return;
        try {
            var source = queue.source(lease);
            if (source == null || source.objectKey() == null) {
                queue.retry(lease);
                return;
            }
            if (volc.isPresent()) {
                volc.get().process(lease, source);
                return;
            }
            String result = "speaker".equals(source.kind())
                    ? "演示转写：周六先看望家人，再决定是否聚餐。"
                    : "演示转写：周六和家人见面，再讨论聚餐安排。";
            queue.complete(lease, result);
        } catch (AsrFailure failure) {
            LOG.warn("Transcription for audio {} failed ({})", lease.audioId(), failure.getMessage());
            if (failure.retryable()) queue.retry(lease);
            else queue.fail(lease);
        } catch (RuntimeException unavailable) {
            LOG.warn("Transcription for audio {} failed ({})", lease.audioId(), unavailable.getClass().getSimpleName());
            queue.retry(lease);
        }
    }

}
