package io.snailecho;

import java.time.Instant;
import java.util.List;

import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;

@Mapper
interface TranscriptionMapper {
    record Job(String audioId, String roundId, String status, int attempts, byte[] resultCiphertext, String provider, byte[] candidatesCiphertext) {}
    record ProviderProgress(Instant startedAt, String taskId, boolean expired) {}

    String COLUMNS = "audio_id, round_id, status, attempts, result_ciphertext, provider, candidates_ciphertext";
    String OWNED = " WHERE audio_id = #{audio} AND status = 'RUNNING' AND lease_token = #{lease}"
            + " AND available_at > CURRENT_TIMESTAMP(6)";
    String ROUND_ACCEPTS_RESULT = """
         AND EXISTS (
             SELECT 1 FROM rounds r WHERE r.id = transcription_jobs.round_id
               AND (r.speaker_audio_id = #{audio}
                 OR (r.listener_audio_id = #{audio} AND r.deadline_at > CURRENT_TIMESTAMP(6)))
         )
         """;

    @Insert("INSERT INTO transcription_jobs (audio_id, round_id, provider) VALUES (#{audio}, #{round}, #{provider})")
    void enqueue(@Param("audio") String audioId, @Param("round") String roundId, @Param("provider") String provider);

    @Select("SELECT " + COLUMNS + " FROM transcription_jobs WHERE audio_id = #{id}")
    Job byId(String id);

    @Select("SELECT " + COLUMNS + " FROM transcription_jobs WHERE provider = #{provider} AND status IN ('PENDING', 'RUNNING')"
            + " AND available_at <= CURRENT_TIMESTAMP(6) ORDER BY available_at, audio_id LIMIT 1 FOR UPDATE SKIP LOCKED")
    Job due(String provider);

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

    @Update("UPDATE transcription_jobs SET status = 'DONE', lease_token = NULL, result_ciphertext = #{result},"
            + " candidates_ciphertext = #{candidates,jdbcType=LONGVARBINARY}"
            + OWNED + " " + ROUND_ACCEPTS_RESULT)
    int succeed(@Param("audio") String audioId, @Param("lease") String lease, @Param("result") byte[] result,
                @Param("candidates") byte[] candidates);

    @Update("""
        UPDATE transcription_jobs SET status = IF(attempts >= 3, 'FAILED', 'PENDING'), lease_token = NULL,
            available_at = TIMESTAMPADD(SECOND, IF(attempts = 1, 2, 8), CURRENT_TIMESTAMP(6))
        """ + OWNED)
    int retry(@Param("audio") String audioId, @Param("lease") String lease);

    @Update("UPDATE transcription_jobs SET status = 'CANCELLED', lease_token = NULL" + OWNED)
    int cancel(@Param("audio") String audioId, @Param("lease") String lease);

    @Select("""
        SELECT provider_started_at AS started_at, provider_task_id AS task_id,
            COALESCE(provider_started_at <= TIMESTAMPADD(SECOND, -180, CURRENT_TIMESTAMP(6)), FALSE) AS expired
        FROM transcription_jobs
        """ + OWNED)
    ProviderProgress progress(@Param("audio") String audioId, @Param("lease") String lease);

    @Update("""
        UPDATE transcription_jobs SET artifact_cleanup_after = TIMESTAMPADD(SECOND, 120, CURRENT_TIMESTAMP(6))
        """ + OWNED + " AND provider_started_at IS NULL")
    int reserveArtifact(@Param("audio") String audioId, @Param("lease") String lease);

    @Update("""
        UPDATE transcription_jobs SET provider_started_at = CURRENT_TIMESTAMP(6), attempts = 1
        """ + OWNED + " AND provider_started_at IS NULL " + ROUND_ACCEPTS_RESULT)
    int startProvider(@Param("audio") String audioId, @Param("lease") String lease);

    @Update("""
        UPDATE transcription_jobs SET status = 'PENDING', lease_token = NULL, attempts = attempts - 1,
            provider_task_id = COALESCE(#{taskId,jdbcType=VARCHAR}, provider_task_id),
            available_at = TIMESTAMPADD(SECOND, 3, CURRENT_TIMESTAMP(6))
        """ + OWNED)
    int defer(@Param("audio") String audioId, @Param("lease") String lease, @Param("taskId") String taskId);

    @Update("UPDATE transcription_jobs SET status = 'FAILED', lease_token = NULL" + OWNED)
    int fail(@Param("audio") String audioId, @Param("lease") String lease);

    @Select("""
        SELECT audio_id FROM transcription_jobs WHERE status IN ('DONE', 'FAILED', 'CANCELLED')
          AND artifact_cleanup_after <= CURRENT_TIMESTAMP(6) ORDER BY artifact_cleanup_after, audio_id LIMIT 25
        """)
    List<String> artifactsDue();

    @Update("""
        UPDATE transcription_jobs SET artifact_cleanup_after = NULL
        WHERE audio_id = #{id} AND status IN ('DONE', 'FAILED', 'CANCELLED')
        """)
    void artifactRemoved(String id);

    @Update("""
        UPDATE transcription_jobs SET artifact_cleanup_after = TIMESTAMPADD(MINUTE, 5, CURRENT_TIMESTAMP(6))
        WHERE audio_id = #{id} AND artifact_cleanup_after <= CURRENT_TIMESTAMP(6)
          AND status IN ('DONE', 'FAILED', 'CANCELLED')
        """)
    void retryArtifactCleanup(String id);

    @Update("""
        UPDATE transcription_jobs SET status = 'CANCELLED', lease_token = NULL
        WHERE round_id = #{id} AND status IN ('PENDING', 'RUNNING')
        """)
    void cancelPendingForRound(String id);
}
