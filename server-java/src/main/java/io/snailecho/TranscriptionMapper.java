package io.snailecho;

import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;

@Mapper
interface TranscriptionMapper {
    record Job(String audioId, String roundId, String status, int attempts, byte[] resultCiphertext) {}

    String COLUMNS = "audio_id, round_id, status, attempts, result_ciphertext";
    String OWNED = " WHERE audio_id = #{audio} AND status = 'RUNNING' AND lease_token = #{lease}"
            + " AND available_at > CURRENT_TIMESTAMP(6)";

    @Insert("INSERT INTO transcription_jobs (audio_id, round_id) VALUES (#{audio}, #{round})")
    void enqueue(@Param("audio") String audioId, @Param("round") String roundId);

    @Select("SELECT " + COLUMNS + " FROM transcription_jobs WHERE audio_id = #{id}")
    Job byId(String id);

    @Select("SELECT " + COLUMNS + " FROM transcription_jobs WHERE status IN ('PENDING', 'RUNNING')"
            + " AND available_at <= CURRENT_TIMESTAMP(6) ORDER BY available_at, audio_id LIMIT 1 FOR UPDATE SKIP LOCKED")
    Job due();

    @Update("""
        UPDATE transcription_jobs SET status = 'RUNNING', attempts = attempts + 1,
            available_at = TIMESTAMPADD(SECOND, 120, CURRENT_TIMESTAMP(6)), lease_token = #{lease}
        WHERE audio_id = #{audio}
        """)
    void lease(@Param("audio") String audioId, @Param("lease") String lease);

    @Update("UPDATE transcription_jobs SET status = 'FAILED', lease_token = NULL WHERE audio_id = #{id}")
    void exhausted(String id);

    @Select("SELECT COUNT(*) FROM transcription_jobs" + OWNED)
    int owned(@Param("audio") String audioId, @Param("lease") String lease);

    @Update("UPDATE transcription_jobs SET status = 'DONE', lease_token = NULL, result_ciphertext = #{result}" + OWNED + """
        AND EXISTS (
            SELECT 1 FROM rounds r WHERE r.id = transcription_jobs.round_id
              AND (r.speaker_audio_id = #{audio}
                OR (r.listener_audio_id = #{audio} AND r.deadline_at > CURRENT_TIMESTAMP(6)))
        )
        """)
    int succeed(@Param("audio") String audioId, @Param("lease") String lease, @Param("result") byte[] result);

    @Update("""
        UPDATE transcription_jobs SET status = IF(attempts >= 3, 'FAILED', 'PENDING'), lease_token = NULL,
            available_at = TIMESTAMPADD(SECOND, IF(attempts = 1, 2, 8), CURRENT_TIMESTAMP(6))
        """ + OWNED)
    int retry(@Param("audio") String audioId, @Param("lease") String lease);

    @Update("UPDATE transcription_jobs SET status = 'CANCELLED', lease_token = NULL" + OWNED)
    int cancel(@Param("audio") String audioId, @Param("lease") String lease);

    @Update("""
        UPDATE transcription_jobs SET status = 'CANCELLED', lease_token = NULL
        WHERE round_id = #{id} AND status IN ('PENDING', 'RUNNING')
        """)
    void cancelPendingForRound(String id);
}
