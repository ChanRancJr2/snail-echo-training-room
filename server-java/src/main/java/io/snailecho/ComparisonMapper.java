package io.snailecho;

import java.util.List;

import org.apache.ibatis.annotations.Arg;
import org.apache.ibatis.annotations.ConstructorArgs;
import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;
import org.apache.ibatis.type.BlobTypeHandler;

@Mapper
interface ComparisonMapper {
    record Candidate(String id, String roomId, long version) {}
    record ReportDetails(String focus, String speaker, String listener, int hintLevel) {}
    record StoredReview(byte[] ciphertext) {}

    @Select("""
        SELECT r.id, r.room_id, r.version FROM rounds r
        JOIN rooms room ON room.id = r.room_id AND room.status = 'ACTIVE'
        LEFT JOIN transcription_jobs listener ON listener.audio_id = r.listener_audio_id
        LEFT JOIN transcription_jobs speaker ON speaker.audio_id = r.speaker_audio_id
        WHERE r.stage = 'COMPARING'
          AND (r.deadline_at <= CURRENT_TIMESTAMP(6)
            OR listener.status IN ('FAILED', 'CANCELLED')
            OR (listener.status = 'DONE'
              AND (speaker.status IS NULL OR speaker.status IN ('DONE', 'FAILED', 'CANCELLED'))))
        ORDER BY r.deadline_at, r.id LIMIT 25
        """)
    List<Candidate> due();

    @Insert("INSERT INTO round_comparisons (round_id, review_ciphertext) VALUES (#{id}, #{content})")
    void insert(@Param("id") String id, @Param("content") byte[] content);

    @Select("SELECT review_ciphertext FROM round_comparisons WHERE round_id = #{id}")
    @ConstructorArgs(@Arg(column = "review_ciphertext", javaType = byte[].class, typeHandler = BlobTypeHandler.class))
    StoredReview load(String id);

    @Select("""
        SELECT id FROM (
            SELECT id, speaker_session_id, listener_session_id
            FROM rounds WHERE room_id = #{room} AND stage = 'ARCHIVED'
            ORDER BY sequence_no DESC LIMIT 1
        ) latest
        WHERE #{actor} IN (speaker_session_id, listener_session_id)
        """)
    String latestArchive(@Param("room") String roomId, @Param("actor") String actor);

    @Select("SELECT deadline_at <= CURRENT_TIMESTAMP(6) FROM rounds WHERE id = #{id}")
    boolean deadlinePassed(String id);

    @Update("UPDATE round_comparisons SET review_ciphertext = #{content} WHERE round_id = #{id}")
    void save(@Param("id") String id, @Param("content") byte[] content);

    @Update("""
        UPDATE rounds SET stage = #{next}, version = version + 1, deadline_at = NULL,
            terminal_reason = CASE WHEN #{next} = 'CANCELLED' THEN 'COMPARISON_FAILED' ELSE NULL END
        WHERE id = #{id} AND stage = #{stage} AND version = #{version}
        """)
    int advance(@Param("id") String id, @Param("stage") String stage, @Param("version") long version,
                @Param("next") String next);

    @Select("""
        SELECT r.focus, s.nickname AS speaker, l.nickname AS listener,
            CASE WHEN r.keywords_used THEN 3 WHEN r.replay_used THEN 2 ELSE 1 END AS hint_level
        FROM rounds r JOIN anonymous_sessions s ON s.id = r.speaker_session_id
        JOIN anonymous_sessions l ON l.id = r.listener_session_id WHERE r.id = #{id}
        """)
    ReportDetails report(String id);
}
