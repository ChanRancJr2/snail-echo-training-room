package io.snailecho;

import java.util.UUID;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.CookieValue;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

@RestController
class ListenerEngagementController {
    private final JdbcTemplate database;
    private final SessionService sessions;
    private final String origin;

    ListenerEngagementController(JdbcTemplate database, SessionService sessions, @Value("${echo.origin}") String origin) {
        this.database = database;
        this.sessions = sessions;
        this.origin = origin;
    }

    record Measurement(@NotNull @Pattern(regexp = "[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}") String visitId,
                       @NotNull @Min(0) @Max(86_400_000) Integer playbackMs,
                       @NotNull @Min(0) @Max(1000) Integer recordingAttempts,
                       @NotNull @Min(0) @Max(86_400_000) Integer dwellMs) {}

    @PostMapping("/api/rounds/{roundId}/listener-engagement")
    ResponseEntity<Void> save(@PathVariable UUID roundId,
                              @RequestHeader(value = "Origin", required = false) String from,
                              @CookieValue(value = "echo_session", required = false) String cookie,
                              @Valid @RequestBody Measurement data) {
        if (!origin.equals(from)) throw new ApiFailure(403, "ORIGIN_DENIED");
        String actor = sessions.require(cookie).id();
        var eligible = database.queryForObject("""
            SELECT EXISTS (
                SELECT 1 FROM rounds r JOIN rooms rm ON rm.id = r.room_id
                WHERE r.id = ? AND rm.mode = 'sync' AND r.listener_session_id = ?
                    AND r.speaker_audio_id IS NOT NULL
                    AND r.stage IN ('LISTENER_RETELL', 'COMPARING', 'SPEAKER_LABELING', 'MUTUAL_CONFIRM', 'LISTENER_CLARIFICATION', 'ADVICE', 'ARCHIVED', 'CANCELLED')
            )
            """, Boolean.class, roundId.toString(), actor);
        if (!Boolean.TRUE.equals(eligible)) throw new ApiFailure(403, "FORBIDDEN_ROLE");
        database.update("""
            INSERT INTO listener_engagement (round_id, visit_id, playback_ms, recording_attempts, dwell_ms)
            VALUES (?, ?, ?, ?, ?) AS incoming
            ON DUPLICATE KEY UPDATE playback_ms = GREATEST(listener_engagement.playback_ms, incoming.playback_ms),
                recording_attempts = GREATEST(listener_engagement.recording_attempts, incoming.recording_attempts),
                dwell_ms = GREATEST(listener_engagement.dwell_ms, incoming.dwell_ms)
            """, roundId.toString(), data.visitId(), data.playbackMs(), data.recordingAttempts(), data.dwellMs());
        return ResponseEntity.noContent().cacheControl(CacheControl.noStore()).build();
    }
}
