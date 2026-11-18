package io.snailecho;

import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;

@Mapper
interface AudioMapper {
    record Asset(String id, String roundId, String sessionId, String kind, String mimeType,
                 int byteSize, long roundVersion, String objectKey) {
        String stagingKey() { return "pending/" + roundId + "/" + id; }
    }

    String COLUMNS = "id, round_id, session_id, kind, mime_type, byte_size, round_version, object_key";

    @Select("SELECT " + RoomMapper.ROUND_COLUMNS + " FROM rounds WHERE id = #{id}")
    RoomMapper.Round round(String id);

    @Select("SELECT " + COLUMNS + " FROM audio_assets WHERE round_id = #{round} AND kind = #{kind} AND idempotency_key = #{key}")
    Asset byKey(@Param("round") String round, @Param("kind") String kind, @Param("key") String key);

    @Select("SELECT " + COLUMNS + " FROM audio_assets WHERE round_id = #{round} AND id = #{id}")
    Asset byId(@Param("round") String round, @Param("id") String id);

    @Select("SELECT room.duration_seconds FROM rounds r JOIN rooms room ON room.id = r.room_id WHERE r.id = #{roundId}")
    int durationSeconds(String roundId);

    @Select("SELECT " + COLUMNS + " FROM audio_assets WHERE round_id = #{round} AND committed_kind = #{kind}")
    Asset committed(@Param("round") String round, @Param("kind") String kind);

    @Select("SELECT COUNT(*) FROM audio_assets WHERE round_id = #{round} AND kind = #{kind}")
    int count(@Param("round") String round, @Param("kind") String kind);

    @Select("SELECT COUNT(*) FROM rounds WHERE id = #{id} AND deadline_at > " + RoomMapper.RECORDING_GRACE_CUTOFF)
    int recordingWindowOpen(String id);

    @Insert("""
        INSERT INTO audio_assets (id, round_id, session_id, kind, mime_type, byte_size, round_version, idempotency_key)
        VALUES (#{asset.id}, #{asset.roundId}, #{asset.sessionId}, #{asset.kind}, #{asset.mimeType},
            #{asset.byteSize}, #{asset.roundVersion}, #{key})
        """)
    void insert(@Param("asset") Asset asset, @Param("key") String idempotencyKey);

    @Update("UPDATE audio_assets SET object_key = #{key}, committed_at = CURRENT_TIMESTAMP(6) WHERE id = #{id} AND object_key IS NULL")
    int seal(@Param("id") String id, @Param("key") String objectKey);

    @Update("""
        UPDATE rounds SET speaker_audio_id = #{asset}, stage = 'KEYPOINT_CONFIRM', deadline_at = NULL, version = version + 1
        WHERE id = #{round} AND stage = 'SPEAKER_RECORDING' AND version = #{version} AND speaker_audio_id IS NULL
            AND deadline_at >
        """ + RoomMapper.RECORDING_GRACE_CUTOFF)
    int commitSpeaker(@Param("round") String round, @Param("asset") String asset, @Param("version") long version);

    @Update("""
        UPDATE rounds SET listener_audio_id = #{asset}, stage = 'COMPARING',
            deadline_at = TIMESTAMPADD(SECOND, 300, CURRENT_TIMESTAMP(6)), version = version + 1
        WHERE id = #{round} AND stage = 'LISTENER_RETELL' AND version = #{version} AND listener_audio_id IS NULL
            AND deadline_at >
        """ + RoomMapper.RECORDING_GRACE_CUTOFF)
    int commitListener(@Param("round") String round, @Param("asset") String asset, @Param("version") long version);
}
