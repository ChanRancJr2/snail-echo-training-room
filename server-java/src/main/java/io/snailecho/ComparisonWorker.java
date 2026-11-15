package io.snailecho;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Component
@ConditionalOnProperty(name = "echo.processing.enabled", havingValue = "true")
class ComparisonWorker {
    private static final Logger LOG = LoggerFactory.getLogger(ComparisonWorker.class);
    private final ComparisonMapper database;
    private final ComparisonService service;

    ComparisonWorker(ComparisonMapper database, ComparisonService service) {
        this.database = database;
        this.service = service;
    }

    @Scheduled(fixedDelayString = "${echo.processing.comparison-delay-ms:1000}",
            initialDelayString = "${echo.processing.comparison-delay-ms:1000}")
    public void sweep() {
        for (var candidate : database.due()) {
            try {
                service.build(candidate);
            } catch (RuntimeException failure) {
                LOG.warn("Comparison processing failed for round {} ({})", candidate.id(), failure.getClass().getSimpleName());
                service.expireFailed(candidate);
            }
        }
    }
}
