package io.snailecho;

import java.time.Instant;
import java.util.List;

import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.CookieValue;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/practice/reports")
class SinglePracticeController {
    private final JdbcTemplate database;
    private final SessionService sessions;
    SinglePracticeController(JdbcTemplate database, SessionService sessions) {
        this.database = database;
        this.sessions = sessions;
    }

    record Report(String id, String materialId, int duration, String transcriptSource, int complete, int accurate,
                  int total, boolean accepted, Instant createdAt) {}

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
