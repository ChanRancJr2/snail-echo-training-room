package io.snailecho;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.Semaphore;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.multipart.MultipartFile;

@Service
@ConditionalOnProperty(name = "echo.processing.enabled", havingValue = "true")
class SoloPracticeAnalysis {
    private static final Logger LOG = LoggerFactory.getLogger(SoloPracticeAnalysis.class);
    private final Semaphore transcodes = new Semaphore(2);
    private final JdbcTemplate db;
    private final TransactionTemplate tx;
    private final TextVault vault;
    private final ObjectMapper json;
    private final SoloPracticeScoring scoring;
    private final CoachingAdvice coaching;
    private final Optional<S3AudioStorage> storage;
    private final Optional<FfmpegAudio> converter;
    private final Optional<VolcFileAsr> speech;

    record View(String status, String source, String transcript, SoloPracticeScoring.Comparison comparison,
                String provider, String failure) {}
    private record Job(String id, String owner, String material, int duration, String status,
                       byte[] transcript, byte[] result, String audioKey, boolean submitted, String providerTask,
                       String failure, Instant created) {}
    record ReviewChoice(String issueId, String resolution) {}
    private record Lease(Job job, String token) {}

    SoloPracticeAnalysis(JdbcTemplate db, PlatformTransactionManager transactions, TextVault vault, ObjectMapper json,
            SoloPracticeScoring scoring, CoachingAdvice coaching, Optional<S3AudioStorage> storage, Optional<FfmpegAudio> converter,
            Optional<VolcFileAsr> speech) {
        this.db = db;
        this.tx = new TransactionTemplate(transactions);
        this.tx.setIsolationLevel(TransactionDefinition.ISOLATION_READ_COMMITTED);
        this.vault = vault;
        this.json = json;
        this.scoring = scoring;
        this.coaching = coaching;
        this.storage = storage;
        this.converter = converter;
        this.speech = speech;
    }

    void submitAudio(String id, String owner, String material, int duration, MultipartFile file) {
        validate(material, duration);
        if (alreadyExists(id, owner, material, duration)) return;
        if (converter.isEmpty() || speech.isEmpty() || storage.isEmpty()) throw new ApiFailure(503, "SOLO_ASR_UNAVAILABLE");
        String mime = AudioFormat.mime(file.getContentType());
        if (mime == null || file.isEmpty() || file.getSize() > AudioFormat.MAX_BYTES) {
            throw new ApiFailure(400, "UNSUPPORTED_AUDIO");
        }
        if (!transcodes.tryAcquire()) throw new ApiFailure(429, "SOLO_PROCESSING_BUSY");
        try {
            byte[] bytes = file.getBytes();
            if (!mime.equals(AudioFormat.detect(bytes))) throw new ApiFailure(400, "UNSUPPORTED_AUDIO");
            var mp3 = converter.orElseThrow().mp3(bytes, mime, duration);
            var objects = storage.orElseThrow();
            String key = S3AudioStorage.asrKey(UUID.randomUUID().toString());
            objects.stageForAsr(key, mp3);
            try {
                if (!insert(id, owner, material, duration, key)) objects.discard(key);
            } catch (RuntimeException failure) {
                // A database failure may have arrived after commit.
                var saved = find(id);
                if (saved == null || !key.equals(saved.audioKey())) objects.discard(key);
                throw failure;
            }
        } catch (IOException failed) {
            throw new ApiFailure(400, "INVALID_AUDIO");
        } catch (AsrFailure failed) {
            throw failed.retryable() ? new ApiFailure(503, "SOLO_ASR_UNAVAILABLE") : new ApiFailure(400, "INVALID_AUDIO");
        } finally {
            transcodes.release();
        }
    }

    private void validate(String material, int duration) {
        scoring.validateMaterial(material);
        if (!List.of(30, 60, 120, 300).contains(duration)) throw new ApiFailure(400, "INVALID_INPUT");
    }

    private boolean alreadyExists(String id, String owner, String material, int duration) {
        var existing = find(id);
        if (existing == null) return false;
        if (!owner.equals(existing.owner()) || !material.equals(existing.material())
                || duration != existing.duration()) throw missing();
        return true;
    }

    private boolean insert(String id, String owner, String material, int duration, String key) {
        return Boolean.TRUE.equals(tx.execute(ignored -> {
            db.queryForObject("SELECT id FROM anonymous_sessions WHERE id=? FOR UPDATE", String.class, owner);
            if (alreadyExists(id, owner, material, duration)) return false;
            Integer active = db.queryForObject("SELECT COUNT(*) FROM solo_analysis WHERE session_id=? AND status='pending'",
                    Integer.class, owner);
            if (active != null && active >= 1) throw new ApiFailure(429, "SOLO_PROCESSING_BUSY");
            int inserted = db.update("""
                INSERT IGNORE INTO solo_analysis(id, session_id, material_id, duration_seconds, audio_key)
                VALUES (?,?,?,?,?)
                """, id, owner, material, duration, key);
            if (inserted == 0 && !alreadyExists(id, owner, material, duration)) {
                throw new ApiFailure(503, "SOLO_PROCESSING_UNAVAILABLE");
            }
            return inserted == 1;
        }));
    }

    View view(String id, String owner) {
        var job = owned(id, owner);
        if (!"ready".equals(job.status())) return new View(job.status(), "asr", null, null, null, job.failure());
        var result = result(job);
        return new View("ready", "asr", vault.open("solo-text:" + id, job.transcript()),
                result.comparison(), result.provider(), null);
    }

    CoachingAdvice.View submitReview(String id, String owner, List<ReviewChoice> choices) {
        var job = owned(id, owner);
        if (!"ready".equals(job.status())) throw new ApiFailure(409, "SOLO_NOT_READY");
        var issues = result(job).comparison().issues();
        Map<String, String> resolved = new HashMap<>();
        for (var choice : choices) {
            if (choice == null || choice.issueId() == null || choice.resolution() == null
                    || !List.of("expression", "misunderstanding", "ai_error").contains(choice.resolution())
                    || resolved.putIfAbsent(choice.issueId(), choice.resolution()) != null) {
                throw new ApiFailure(400, "INVALID_INPUT");
            }
        }
        if (resolved.size() != issues.size() || issues.stream().anyMatch(issue -> !resolved.containsKey(issue.id()))) {
            throw new ApiFailure(400, "INVALID_INPUT");
        }
        var evidence = issues.stream().filter(issue -> !"ai_error".equals(resolved.get(issue.id())))
                .map(issue -> new ArkComparison.CoachingEvidence(issue.id(), issue.original(), issue.retell(), resolved.get(issue.id())))
                .toList();
        coaching.enqueue("solo:" + id, evidence, List.of("listener"));
        return coaching.view("solo:" + id);
    }

    CoachingAdvice.View advice(String id, String owner) {
        owned(id, owner);
        var result = coaching.view("solo:" + id);
        if (result == null) throw new ApiFailure(404, "SOLO_ADVICE_NOT_FOUND");
        return result;
    }

    CoachingAdvice.View submitWholeReview(String id, String owner, WholeRoundFeedback feedback) {
        var job = owned(id, owner);
        if (!"ready".equals(job.status())) throw new ApiFailure(409, "SOLO_NOT_READY");
        var evidence = result(job).comparison().issues().stream()
                .map(issue -> new ArkComparison.CoachingEvidence(issue.id(), issue.original(), issue.retell(), "system_detected"))
                .toList();
        coaching.enqueue("solo:" + id, evidence, List.of("listener"), feedback);
        return coaching.view("solo:" + id);
    }

    void archive(String id, String owner, boolean accepted) {
        var job = owned(id, owner);
        if (!"ready".equals(job.status())) throw new ApiFailure(409, "SOLO_NOT_READY");
        var scores = result(job).comparison();
        db.update("""
            INSERT INTO single_practice_reports
              (session_id, id, material_id, duration_seconds, transcript_source, complete, accurate, total, accepted)
            VALUES (?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE id=id
            """, owner, id, job.material(), job.duration(), "asr", scores.complete(), scores.accurate(),
                scores.total(), accepted);
    }

    @Scheduled(fixedDelayString = "${echo.processing.solo-delay-ms:1000}",
            initialDelayString = "${echo.processing.solo-delay-ms:1000}")
    public void run() {
        var lease = claim();
        if (lease == null) return;
        var job = lease.job();
        try {
            if (job.created().plusSeconds(240).isBefore(Instant.now())) {
                fail(lease, "TIMEOUT");
                return;
            }
            String transcript = recognize(lease);
            if (transcript == null) return;
            if (transcript.isBlank()) {
                fail(lease, "NO_SPEECH");
                return;
            }
            var comparison = scoring.compare(job.material(), transcript);
            db.update("""
                UPDATE solo_analysis SET status='ready', lease=NULL, transcript=?, result=? WHERE id=? AND lease=? AND status='pending'
                """, vault.seal("solo-text:" + job.id(), transcript), vault.seal("solo-result:" + job.id(), json.writeValueAsString(comparison)),
                job.id(), lease.token());
        } catch (AsrFailure error) {
            LOG.warn("Solo practice transcription failed ({})", error.getMessage());
            if (error.retryable()) defer(lease, job.providerTask());
            else fail(lease, "TRANSCRIPTION_FAILED");
        } catch (JsonProcessingException | RuntimeException error) {
            LOG.warn("Solo analysis failed ({})", error.getClass().getSimpleName());
            fail(lease, "PROCESSING_FAILED");
        }
    }

    private Lease claim() {
        return tx.execute(ignored -> {
            var job = db.query("""
                SELECT * FROM solo_analysis WHERE status='pending' AND next_at<=CURRENT_TIMESTAMP(6)
                ORDER BY next_at,id LIMIT 1 FOR UPDATE SKIP LOCKED
                """, SoloPracticeAnalysis::map).stream().findFirst().orElse(null);
            if (job == null) return null;
            String token = UUID.randomUUID().toString();
            db.update("UPDATE solo_analysis SET lease=?, next_at=TIMESTAMPADD(SECOND,60,CURRENT_TIMESTAMP(6)) WHERE id=?",
                    token, job.id());
            return new Lease(job, token);
        });
    }

    private String recognize(Lease lease) {
        var job = lease.job();
        var provider = speech.orElseThrow(() -> new AsrFailure("SOLO_ASR_UNAVAILABLE", false));
        if (!job.submitted()) {
            int fenced = db.update("""
                UPDATE solo_analysis SET provider_started=true WHERE id=? AND lease=? AND status='pending' AND provider_started=false
                """, job.id(), lease.token());
            if (fenced == 1) {
                String task = provider.submit(job.id(), storage.orElseThrow().asrDownloadUrl(job.audioKey()));
                defer(lease, task);
            }
            return null;
        }
        var result = provider.query(job.providerTask() == null ? job.id() : job.providerTask());
        if (!result.pending()) return result.text();
        defer(lease, job.providerTask());
        return null;
    }

    private void defer(Lease lease, String task) {
        db.update("""
            UPDATE solo_analysis SET provider_task=COALESCE(?,provider_task), lease=NULL,
              next_at=TIMESTAMPADD(SECOND,3,CURRENT_TIMESTAMP(6)) WHERE id=? AND lease=? AND status='pending'
            """, task, lease.job().id(), lease.token());
    }

    private void fail(Lease lease, String code) {
        db.update("UPDATE solo_analysis SET status='failed', lease=NULL, failure=?, transcript=NULL WHERE id=? AND lease=?",
                code, lease.job().id(), lease.token());
    }

    @Scheduled(fixedDelayString = "${echo.processing.solo-cleanup-ms:15000}")
    public void cleanup() {
        if (storage.isPresent()) {
            for (String key : db.queryForList("""
                    SELECT audio_key FROM solo_analysis WHERE status<>'pending' AND audio_key IS NOT NULL LIMIT 25
                    """, String.class)) {
                if (storage.get().discard(key)) db.update("UPDATE solo_analysis SET audio_key=NULL WHERE audio_key=?", key);
            }
        }
        db.update("""
            DELETE FROM solo_analysis WHERE status<>'pending' AND audio_key IS NULL
              AND created_at<TIMESTAMPADD(HOUR,-24,CURRENT_TIMESTAMP(6)) LIMIT 100
            """);
    }

    private SoloPracticeScoring.Outcome result(Job job) {
        try {
            return json.readValue(vault.open("solo-result:" + job.id(), job.result()), SoloPracticeScoring.Outcome.class);
        } catch (JsonProcessingException error) {
            throw new UncheckedIOException(error);
        }
    }

    private Job owned(String id, String owner) {
        var job = find(id);
        if (job == null || !owner.equals(job.owner())) throw missing();
        return job;
    }

    private Job find(String id) {
        return db.query("SELECT * FROM solo_analysis WHERE id=?", SoloPracticeAnalysis::map, id).stream().findFirst().orElse(null);
    }

    private static Job map(java.sql.ResultSet rs, int row) throws java.sql.SQLException {
        return new Job(rs.getString("id"), rs.getString("session_id"), rs.getString("material_id"),
                rs.getInt("duration_seconds"), rs.getString("status"), rs.getBytes("transcript"),
                rs.getBytes("result"), rs.getString("audio_key"), rs.getBoolean("provider_started"),
                rs.getString("provider_task"), rs.getString("failure"), rs.getTimestamp("created_at").toInstant());
    }

    private static ApiFailure missing() { return new ApiFailure(404, "SOLO_ANALYSIS_NOT_FOUND"); }
}
