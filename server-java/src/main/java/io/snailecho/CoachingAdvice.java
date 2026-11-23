package io.snailecho;

import java.io.UncheckedIOException;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

@Service
@ConditionalOnProperty(name = "echo.processing.enabled", havingValue = "true")
class CoachingAdvice {
    private static final Logger LOG = LoggerFactory.getLogger(CoachingAdvice.class);
    private final JdbcTemplate db;
    private final TransactionTemplate transactions;
    private final TextVault vault;
    private final ObjectMapper json;
    private final Optional<ArkComparison> ark;

    record Advice(String text, String evidenceId, String provider) {}
    record View(String status, Map<String, Advice> suggestions) {}
    private record Request(List<ArkComparison.CoachingEvidence> evidence, List<String> roles, WholeRoundFeedback feedback) {}
    private record Lease(String id, byte[] input, String token, Instant created) {}

    CoachingAdvice(JdbcTemplate db, PlatformTransactionManager transactions, TextVault vault, ObjectMapper json,
                   Optional<ArkComparison> ark) {
        this.db = db;
        this.transactions = new TransactionTemplate(transactions);
        this.vault = vault;
        this.json = json;
        this.ark = ark;
    }

    void enqueue(String scope, List<ArkComparison.CoachingEvidence> evidence, List<String> roles) {
        enqueue(scope, evidence, roles, null);
    }

    void enqueue(String scope, List<ArkComparison.CoachingEvidence> evidence, List<String> roles, WholeRoundFeedback feedback) {
        var request = new Request(evidence.stream().limit(6).toList(), roles, feedback);
        boolean useModel = ark.isPresent() && !request.evidence().isEmpty();
        db.update("""
            INSERT INTO rewrite_advice(scope_id,input_data,result_data) VALUES(?,?,?)
            ON DUPLICATE KEY UPDATE scope_id=scope_id
            """, scope, useModel || feedback != null ? encode(scope + ":input", request) : null,
                useModel ? null : encode(scope + ":result", fallback(request)));
    }

    View view(String scope) {
        return db.query("SELECT result_data FROM rewrite_advice WHERE scope_id=?", (row, index) -> {
            byte[] result = row.getBytes(1);
            return result == null ? new View("pending", Map.of()) : decode(scope + ":result", result, View.class);
        }, scope).stream().findFirst().orElse(null);
    }

    @Scheduled(fixedDelayString = "${echo.processing.advice-delay-ms:1500}",
            initialDelayString = "${echo.processing.advice-delay-ms:1500}")
    public void run() {
        var picked = transactions.execute(ignored -> {
            String token = UUID.randomUUID().toString();
            var leases = db.query("""
                SELECT scope_id,input_data,created_at FROM rewrite_advice
                WHERE input_data IS NOT NULL AND result_data IS NULL AND next_at<=CURRENT_TIMESTAMP(6)
                ORDER BY next_at,scope_id LIMIT 1 FOR UPDATE SKIP LOCKED
                """, (row, index) -> new Lease(row.getString(1), row.getBytes(2), token, row.getTimestamp(3).toInstant()));
            if (leases.isEmpty()) return null;
            var lease = leases.getFirst();
            db.update("""
                UPDATE rewrite_advice SET lease=?, next_at=TIMESTAMPADD(SECOND,50,CURRENT_TIMESTAMP(6)) WHERE scope_id=?
                """, token, lease.id());
            return lease;
        });
        if (picked == null) return;
        var request = decode(picked.id() + ":input", picked.input(), Request.class);
        View result = fallback(request);
        if (ark.isPresent() && picked.created().plusSeconds(120).isAfter(Instant.now())) {
            try {
                var model = generatedAdvice(request);
                var merged = new LinkedHashMap<>(result.suggestions());
                model.forEach((role, suggestion) -> merged.put(role, new Advice(suggestion.text(), suggestion.evidenceId(), "ark")));
                result = new View("ready", Map.copyOf(merged));
            } catch (ArkComparison.Failure failure) {
                LOG.warn("Rewrite advice fell back to rules ({})", failure.getMessage());
            }
        }
        db.update("""
            UPDATE rewrite_advice SET result_data=?, input_data=NULL, lease=NULL WHERE scope_id=? AND lease=?
            """, encode(picked.id() + ":result", result), picked.id(), picked.token());
    }

    private Map<String, ArkComparison.CoachingSuggestion> generatedAdvice(Request request) {
        var provider = ark.orElseThrow();
        var suggestions = new LinkedHashMap<>(ArkComparison.retryTransient(() -> provider.rewrite(request.evidence(), request.roles(), request.feedback())));
        if (request.roles().size() == 2 && suggestions.size() == 1) {
            var missing = request.roles().stream().filter(role -> !suggestions.containsKey(role)).toList();
            try {
                suggestions.putAll(provider.rewrite(request.evidence(), missing, request.feedback()));
            } catch (ArkComparison.Failure failure) {
                LOG.warn("Supplementary rewrite advice fell back to rules ({})", failure.getMessage());
            }
        }
        return suggestions;
    }

    @Scheduled(fixedDelay = 3600000)
    public void cleanup() {
        db.update("""
            DELETE FROM rewrite_advice WHERE scope_id LIKE 'solo:%'
              AND created_at<TIMESTAMPADD(HOUR,-24,CURRENT_TIMESTAMP(6)) LIMIT 100
            """);
    }

    private static View fallback(Request request) {
        var suggestions = new LinkedHashMap<String, Advice>();
        var first = request.evidence().stream().findFirst().orElse(null);
        for (String role : request.roles()) {
            boolean speaker = "speaker".equals(role);
            String suggestion;
            if (first == null) {
                suggestion = speaker ? "每句话先说清一个主要意思，再单独说明时间和条件。"
                        : "复述后核对关键时间、条件和先后顺序。";
                if (request.feedback() != null) {
                    var tags = speaker ? request.feedback().expressionTags() : request.feedback().retellTags();
                    if (!tags.isEmpty()) suggestion = "本轮标记了「" + tags.getFirst() + "」。" + suggestion;
                }
            } else {
                suggestion = (speaker ? "先说清这一点的背景和条件：" : "复述后用自己的话核对这一点：") + first.original();
            }
            suggestions.put(role, new Advice(suggestion, first == null ? null : first.id(), "rules"));
        }
        return new View("ready", Map.copyOf(suggestions));
    }

    private byte[] encode(String scope, Object value) {
        try {
            return vault.seal("rewrite:" + scope, json.writeValueAsString(value));
        } catch (JsonProcessingException error) {
            throw new UncheckedIOException(error);
        }
    }

    private <T> T decode(String scope, byte[] value, Class<T> type) {
        try {
            return json.readValue(vault.open("rewrite:" + scope, value), type);
        } catch (JsonProcessingException error) {
            throw new UncheckedIOException(error);
        }
    }
}
