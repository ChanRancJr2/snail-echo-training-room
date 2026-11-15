package io.snailecho;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Component
@ConditionalOnProperty(name = "echo.processing.enabled", havingValue = "true")
class TranscriptionWorker {
    private final TranscriptionQueue queue;

    TranscriptionWorker(TranscriptionQueue queue, @Value("${echo.processing.mode:}") String mode) {
        if (!"mock".equals(mode)) throw new IllegalStateException("Set JAVA_TRANSCRIPTION_MODE=mock for local processing");
        this.queue = queue;
    }

    @Scheduled(fixedDelayString = "${echo.processing.worker-delay-ms:1000}",
            initialDelayString = "${echo.processing.worker-delay-ms:1000}")
    public void runOne() {
        var lease = queue.claim();
        if (lease == null) return;
        String result;
        try {
            var source = queue.source(lease);
            if (source == null || source.objectKey() == null) {
                queue.retry(lease);
                return;
            }
            result = "speaker".equals(source.kind())
                    ? "演示转写：周六先看望家人，再决定是否聚餐。"
                    : "演示转写：周六和家人见面，再讨论聚餐安排。";
        } catch (RuntimeException unavailable) {
            queue.retry(lease);
            return;
        }
        queue.complete(lease, result);
    }
}
