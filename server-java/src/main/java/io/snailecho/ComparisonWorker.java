package io.snailecho;

import java.util.Optional;
import java.util.concurrent.Executor;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.Semaphore;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Component
@ConditionalOnProperty(name = "echo.processing.enabled", havingValue = "true")
class ComparisonWorker {
    static final int CONCURRENT_PROVIDER_CALLS = 4;
    private static final Logger LOG = LoggerFactory.getLogger(ComparisonWorker.class);
    private final ComparisonMapper database;
    private final ComparisonService service;
    private final Optional<ArkComparison> ark;
    private final Executor executor;
    private final Semaphore providerSlots = new Semaphore(CONCURRENT_PROVIDER_CALLS);

    ComparisonWorker(ComparisonMapper database, ComparisonService service, Optional<ArkComparison> ark,
                     @Qualifier("arkComparisonExecutor") Executor executor) {
        this.database = database;
        this.service = service;
        this.ark = ark;
        this.executor = executor;
    }

    @Scheduled(fixedDelayString = "${echo.processing.comparison-delay-ms:1000}",
            initialDelayString = "${echo.processing.comparison-delay-ms:1000}")
    public void sweep() {
        for (var candidate : database.due(ComparisonService.PROVIDER_BUDGET_SECONDS)) {
            boolean slot = ark.isPresent() && providerSlots.tryAcquire();
            ComparisonService.LeasedComparison work;
            try {
                work = service.prepare(candidate, ark.isPresent(), slot);
            } catch (RuntimeException failure) {
                if (slot) providerSlots.release();
                LOG.warn("Comparison processing failed for round {} ({})", candidate.id(), failure.getClass().getSimpleName());
                service.expireFailed(candidate);
                continue;
            }
            if (work == null) {
                if (slot) providerSlots.release();
                continue;
            }
            try {
                executor.execute(() -> {
                    try {
                        compare(work, ark.orElseThrow());
                    } catch (RuntimeException failure) {
                        LOG.warn("Comparison task for round {} failed ({})", work.candidate().id(),
                                failure.getClass().getSimpleName());
                        // The lease stays fenced until it expires and a worker retries or falls back.
                    } finally {
                        providerSlots.release();
                    }
                });
            } catch (RejectedExecutionException stopped) {
                providerSlots.release();
                service.providerFailed(work, true);
            }
        }
    }

    private void compare(ComparisonService.LeasedComparison work, ArkComparison provider) {
        try {
            service.finish(work, provider.compare(work.points(), work.listener()));
        } catch (ArkComparison.Failure failure) {
            LOG.warn("Ark comparison for round {} failed ({})", work.candidate().id(), failure.getMessage());
            service.providerFailed(work, failure.retryable());
        }
    }
}
