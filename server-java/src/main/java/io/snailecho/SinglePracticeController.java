package io.snailecho;

import java.time.Instant;
import java.util.List;

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
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/practice/reports")
class SinglePracticeController {
    private final JdbcTemplate database;
    private final SessionService sessions;
    private final String origin;

    SinglePracticeController(JdbcTemplate database, SessionService sessions, @Value("${echo.origin}") String origin) {
        this.database = database;
        this.sessions = sessions;
        this.origin = origin;
    }

    record Submission(@NotNull @Pattern(regexp = "[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}") String id,
                      @NotNull @Pattern(regexp = "family|campus|work") String materialId,
                      @NotNull Integer duration,
                      @NotNull @Pattern(regexp = "demo|manual") String transcriptSource,
                      @NotNull @Min(0) @Max(12) Integer complete,
                      @NotNull @Min(0) @Max(12) Integer accurate,
                      @NotNull @Min(1) @Max(12) Integer total,
                      @NotNull Boolean accepted) {}

    record Report(String id, String materialId, int duration, String transcriptSource, int complete, int accurate,
                  int total, boolean accepted, Instant createdAt) {}

    @PostMapping
    ResponseEntity<Void> archive(@Valid @RequestBody Submission input,
                                 @RequestHeader(value = "Origin", required = false) String from,
                                 @CookieValue(value = "echo_session", required = false) String cookie) {
        if (!origin.equals(from)) throw new ApiFailure(403, "ORIGIN_DENIED");
        String session = sessions.require(cookie).id();
        if (!List.of(30, 60, 120, 300).contains(input.duration())
                || input.accurate() > input.complete() || input.complete() > input.total()) {
            throw new ApiFailure(400, "INVALID_INPUT");
        }
        database.update("""
            INSERT INTO single_practice_reports
                (session_id, id, material_id, duration_seconds, transcript_source, complete, accurate, total, accepted)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE id = id
            """, session, input.id(), input.materialId(), input.duration(), input.transcriptSource(),
            input.complete(), input.accurate(), input.total(), input.accepted());
        return ResponseEntity.noContent().cacheControl(CacheControl.noStore()).build();
    }

    @GetMapping
    ResponseEntity<List<Report>> recent(@CookieValue(value = "echo_session", required = false) String cookie) {
        String session = sessions.require(cookie).id();
        var reports = database.query("""
            SELECT id, material_id, duration_seconds, transcript_source, complete, accurate, total, accepted, created_at
            FROM single_practice_reports
            WHERE session_id = ?
            ORDER BY created_at DESC, id
            LIMIT 20
            """, (row, index) -> new Report(row.getString("id"), row.getString("material_id"), row.getInt("duration_seconds"),
            row.getString("transcript_source"), row.getInt("complete"), row.getInt("accurate"), row.getInt("total"),
            row.getBoolean("accepted"), row.getTimestamp("created_at").toInstant()), session);
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(reports);
    }
}
