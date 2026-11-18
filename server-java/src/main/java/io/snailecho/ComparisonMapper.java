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
    record Progress(int attempts, boolean available, boolean timeForProvider, boolean expired) {}
    record ReportDetails(String focus, String speaker, String listener, int hintLevel) {}
    record StoredReview(byte[] ciphertext) {}

    @Select("""
        SELECT r.id, r.room_id, r.version FROM rounds r
        JOIN rooms room ON room.id = r.room_id AND room.status = 'ACTIVE'
        LEFT JOIN transcription_jobs listener ON listener.audio_id = r.listener_audio_id
        LEFT JOIN transcription_jobs speaker ON speaker.audio_id = r.speaker_audio_id
        WHERE r.stage = 'COMPARING'
          AND (r.comparison_available_at IS NULL OR r.comparison_available_at <= CURRENT_TIMESTAMP(6)
            OR r.deadline_at <= CURRENT_TIMESTAMP(6))
          AND (r.deadline_at <= CURRENT_TIMESTAMP(6)
            OR listener.status IN ('FAILED', 'CANCELLED')
            OR (listener.status = 'DONE'
              AND (speaker.status IS NULL OR speaker.status IN ('DONE', 'FAILED', 'CANCELLED'))))
        ORDER BY CASE WHEN COALESCE(listener.provider, 'mock') <> 'volc'
            OR COALESCE(listener.status, '') <> 'DONE'
            OR r.comparison_attempts >= 2
            OR r.deadline_at <= TIMESTAMPADD(SECOND, #{budget}, CURRENT_TIMESTAMP(6))
            THEN 0 ELSE 1 END, r.deadline_at, r.id LIMIT 25
        """)
    List<Candidate> due(int budget);

    @Select("""
        SELECT comparison_attempts AS attempts,
            comparison_available_at IS NULL OR comparison_available_at <= CURRENT_TIMESTAMP(6) AS available,
            COALESCE(deadline_at > TIMESTAMPADD(SECOND, #{seconds}, CURRENT_TIMESTAMP(6)), FALSE) AS time_for_provider,
            COALESCE(deadline_at <= CURRENT_TIMESTAMP(6), FALSE) AS expired
        FROM rounds WHERE id = #{id}
        """)
    Progress progress(@Param("id") String id, @Param("seconds") int seconds);

    @Update("""
        UPDATE rounds SET comparison_lease = #{token}, comparison_attempts = comparison_attempts + 1,
            comparison_available_at = TIMESTAMPADD(SECOND, 25, CURRENT_TIMESTAMP(6))
        WHERE id = #{id} AND stage = 'COMPARING' AND version = #{version}
          AND (comparison_available_at IS NULL OR comparison_available_at <= CURRENT_TIMESTAMP(6))
        """)
    int claim(@Param("id") String id, @Param("version") long version, @Param("token") String token);

    @Select("""
        SELECT EXISTS(SELECT 1 FROM rounds WHERE id = #{id} AND comparison_lease = #{token}
          AND comparison_available_at > CURRENT_TIMESTAMP(6))
        """)
    boolean owns(@Param("id") String id, @Param("token") String token);

    @Update("""
        UPDATE rounds SET comparison_lease = NULL,
            comparison_available_at = TIMESTAMPADD(SECOND, 2, CURRENT_TIMESTAMP(6))
        WHERE id = #{id} AND comparison_lease = #{token}
        """)
    void retry(@Param("id") String id, @Param("token") String token);

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
            comparison_lease = NULL, comparison_available_at = NULL,
            terminal_reason = CASE WHEN #{next} = 'CANCELLED' THEN 'COMPARISON_FAILED' ELSE NULL END
        WHERE id = #{id} AND stage = #{stage} AND version = #{version}
        """)
    int advance(@Param("id") String id, @Param("stage") String stage, @Param("version") long version,
                @Param("next") String next);

    @Select("""
        SELECT r.focus,
            CASE WHEN r.teen_role = 'speaker' THEN room.teen_nickname ELSE s.nickname END AS speaker,
            CASE WHEN r.teen_role = 'listener' THEN room.teen_nickname ELSE l.nickname END AS listener,
            CASE WHEN r.keywords_used THEN 3 WHEN r.replay_used THEN 2 ELSE 1 END AS hint_level
        FROM rounds r JOIN rooms room ON room.id = r.room_id
        JOIN anonymous_sessions s ON s.id = r.speaker_session_id
        JOIN anonymous_sessions l ON l.id = r.listener_session_id WHERE r.id = #{id}
        """)
    ReportDetails report(String id);
}
