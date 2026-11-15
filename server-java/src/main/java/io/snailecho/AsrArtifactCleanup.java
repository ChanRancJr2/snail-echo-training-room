package io.snailecho;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Component
@ConditionalOnProperty(name = "echo.storage.enabled", havingValue = "true")
class AsrArtifactCleanup {
    private final TranscriptionMapper database;
    private final S3AudioStorage storage;

    AsrArtifactCleanup(TranscriptionMapper database, S3AudioStorage storage) {
        this.database = database;
        this.storage = storage;
    }

    @Scheduled(fixedDelayString = "${echo.processing.artifact-sweep-delay-ms:15000}",
            initialDelayString = "${echo.processing.artifact-sweep-delay-ms:15000}")
    public void sweep() {
        for (String audioId : database.artifactsDue()) {
            if (storage.discard(S3AudioStorage.asrKey(audioId))) database.artifactRemoved(audioId);
            else database.retryArtifactCleanup(audioId);
        }
    }
}
