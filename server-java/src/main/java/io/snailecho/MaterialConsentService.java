package io.snailecho;

import java.io.IOException;
import java.util.UUID;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.multipart.MultipartFile;

@Service
@ConditionalOnProperty(name = "echo.storage.enabled", havingValue = "true")
class MaterialConsentService {
    private final JdbcTemplate database;
    private final S3AudioStorage storage;

    MaterialConsentService(JdbcTemplate database, S3AudioStorage storage) {
        this.database = database;
        this.storage = storage;
    }

    @Transactional(readOnly = true)
    public boolean roomStatus(String roundId, String audioId, String actor) {
        return database.query("""
            SELECT c.audio_id IS NOT NULL AS submitted
            FROM rounds r
            JOIN audio_assets a ON a.round_id = r.id
            JOIN room_members m ON m.room_id = r.room_id AND m.session_id = a.session_id
            LEFT JOIN room_material_consents c ON c.audio_id = a.id AND c.session_id = a.session_id
            WHERE r.id = ? AND a.id = ? AND a.session_id = ? AND r.stage = 'ARCHIVED'
              AND a.object_key IS NOT NULL AND a.committed_at IS NOT NULL
              AND m.role IN ('speaker', 'listener')
              AND ((a.kind = 'speaker' AND a.id = r.speaker_audio_id AND a.session_id = r.speaker_session_id)
                OR (a.kind = 'listener' AND a.id = r.listener_audio_id AND a.session_id = r.listener_session_id))
            """, rows -> {
            if (!rows.next()) throw new ApiFailure(403, "MATERIAL_AUDIO_NOT_OWNED");
            return rows.getBoolean("submitted");
        }, roundId, audioId, actor);
    }

    @Transactional
    public boolean submitRoom(String roundId, String audioId, String actor) {
        if (roomStatus(roundId, audioId, actor)) return true;
        database.update("""
            INSERT INTO room_material_consents (audio_id, session_id) VALUES (?, ?)
            ON DUPLICATE KEY UPDATE audio_id = audio_id
            """, audioId, actor);
        return true;
    }

    public boolean practiceStatus(String reportId, String actor) {
        return candidateKey(reportId, actor) != null;
    }

    private String candidateKey(String reportId, String actor) {
        return database.query("""
            SELECT c.object_key
            FROM single_practice_reports r
            LEFT JOIN single_practice_material_candidates c ON c.session_id = r.session_id AND c.report_id = r.id
            WHERE r.session_id = ? AND r.id = ?
            """, rows -> {
            if (!rows.next()) throw new ApiFailure(404, "PRACTICE_REPORT_NOT_FOUND");
            return rows.getString("object_key");
        }, actor, reportId);
    }

    public boolean submitPractice(String reportId, String actor, MultipartFile audio) {
        if (practiceStatus(reportId, actor)) return true;
        String mime = AudioFormat.mime(audio.getContentType());
        long size = audio.getSize();
        if (size < 64 || size > AudioFormat.MAX_BYTES) throw ApiFailure.invalid();
        if (mime == null) throw new ApiFailure(400, "UNSUPPORTED_AUDIO");
        byte[] bytes;
        try (var stream = audio.getInputStream()) {
            bytes = stream.readNBytes((int) size + 1);
        } catch (IOException unreadable) {
            throw ApiFailure.invalid();
        }
        if (bytes.length != size || !mime.equals(AudioFormat.detect(bytes))) {
            throw new ApiFailure(400, "UNSUPPORTED_AUDIO");
        }

        String key = "material-candidates/" + UUID.randomUUID();
        storage.putMaterialCandidate(key, mime, bytes);
        try {
            database.update("""
                INSERT INTO single_practice_material_candidates (session_id, report_id, object_key, mime_type, byte_size)
                VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE object_key = object_key
                """, actor, reportId, key, mime, bytes.length);
        } catch (RuntimeException failedWrite) {
            // A commit may have reached the database despite a failed acknowledgement.
            // Cleanup only when the database definitively shows no row referencing this object.
            try {
                if (!key.equals(candidateKey(reportId, actor))) storage.discard(key);
            } catch (RuntimeException unavailable) {
                failedWrite.addSuppressed(unavailable);
            }
            throw failedWrite;
        }
        if (!key.equals(candidateKey(reportId, actor))) storage.discard(key);
        return true;
    }
}
