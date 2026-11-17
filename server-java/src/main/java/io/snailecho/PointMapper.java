package io.snailecho;

import java.util.List;

import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;

@Mapper
interface PointMapper {
    record StoredPoint(String id, int position, String category, byte[] contentCiphertext) {}

    @Select("SELECT id, position, category, content_ciphertext FROM key_points WHERE round_id = #{id} ORDER BY position")
    List<StoredPoint> list(String roundId);

    @Insert("""
        INSERT INTO key_points (id, round_id, position, category, content_ciphertext)
        VALUES (#{point.id}, #{round}, #{point.position}, #{point.category}, #{point.contentCiphertext})
        """)
    void insert(@Param("round") String roundId, @Param("point") StoredPoint point);

    @Update("""
        UPDATE rounds SET stage = #{nextStage}, deadline_at = NULL, version = version + 1
        WHERE id = #{id} AND version = #{version} AND stage = 'KEYPOINT_CONFIRM' AND speaker_audio_id IS NOT NULL
        """)
    int confirm(@Param("id") String roundId, @Param("version") long version, @Param("nextStage") String nextStage);

    @Update("""
        UPDATE rounds SET replay_used = replay_used OR (#{kind} = 'replay'),
            keywords_used = keywords_used OR (#{kind} = 'keywords')
        WHERE id = #{id} AND stage = 'LISTENER_RETELL'
        """)
    void recordAid(@Param("id") String roundId, @Param("kind") String kind);

    @Select("SELECT keywords_used FROM rounds WHERE id = #{id}")
    boolean keywordsUsed(String id);
}
