package io.snailecho;

import java.time.Instant;
import java.util.List;

import org.apache.ibatis.annotations.*;

@Mapper
interface RoomMapper {
    record Room(String id, String ownerId, String status, int durationSeconds, String retellStyle, String topic, long version) {}
    record Member(String id, String sessionId, String nickname, String role, boolean ready, String invitationId) {}
    record Invite(String id, String roomId, String role, String passwordHash, Instant expiresAt, int maxUses, int useCount) {}
    record Round(String id, int sequenceNo, String stage, Instant deadlineAt, long version,
                 String speakerSessionId, String listenerSessionId, String speakerAudioId, String listenerAudioId,
                 String terminalReason) {}
    record DueRecording(String id, String roomId, long version) {}

    String RECORDING_GRACE_CUTOFF = "TIMESTAMPADD(SECOND, -30, CURRENT_TIMESTAMP(6))";

    @Insert("INSERT INTO anonymous_sessions (id, token_hash, nickname, expires_at) VALUES (#{s.id}, #{hash}, #{s.nickname}, #{s.expiresAt})")
    void insertSession(@Param("s") SessionService.Session session, @Param("hash") String hash);

    @Select("SELECT id, nickname, expires_at FROM anonymous_sessions WHERE token_hash = #{hash}")
    SessionService.Session findSession(String hash);

    @Select("SELECT id FROM anonymous_sessions WHERE id = #{id} AND expires_at > CURRENT_TIMESTAMP(6) FOR UPDATE")
    String lockSession(String id);

    String ROOM_COLUMNS = "id, owner_id, status, duration_seconds, retell_style, topic, version";
    String ROUND_COLUMNS = "id, sequence_no, stage, deadline_at, version, speaker_session_id, listener_session_id, "
            + "speaker_audio_id, listener_audio_id, terminal_reason";

    @Select("SELECT " + ROOM_COLUMNS + " FROM rooms WHERE id = #{id}")
    Room room(String id);

    @Select("SELECT " + ROOM_COLUMNS + " FROM rooms WHERE id = #{id} FOR UPDATE")
    Room lockRoom(String id);

    @Select("SELECT " + ROOM_COLUMNS + " FROM rooms WHERE owner_id = #{owner} AND create_key = #{key}")
    Room createdRoom(@Param("owner") String owner, @Param("key") String key);

    @Insert("""
        INSERT INTO rooms (id, owner_id, create_key, duration_seconds, retell_style, topic)
        VALUES (#{id}, #{owner}, #{key}, #{seconds}, #{style}, #{topic})
        """)
    void insertRoom(@Param("id") String id, @Param("owner") String owner, @Param("key") String key,
                    @Param("seconds") int seconds, @Param("style") String style, @Param("topic") String topic);

    @Select("""
        SELECT m.id, m.session_id, s.nickname, m.role, m.ready, m.invitation_id
        FROM room_members m JOIN anonymous_sessions s ON m.session_id = s.id
        WHERE m.room_id = #{roomId} AND s.expires_at > CURRENT_TIMESTAMP(6)
        ORDER BY m.role
        """)
    List<Member> members(String roomId);

    @Insert("""
        INSERT INTO room_members (id, room_id, session_id, role, invitation_id)
        VALUES (#{id}, #{room}, #{session}, #{role}, #{invite})
        """)
    void insertMember(@Param("id") String id, @Param("room") String room, @Param("session") String session,
                      @Param("role") String role, @Param("invite") String invite);

    @Delete("""
        DELETE FROM room_members WHERE room_id = #{room}
          AND session_id IN (SELECT id FROM anonymous_sessions WHERE expires_at <= CURRENT_TIMESTAMP(6))
        """)
    int removeExpiredMembers(String room);

    @Delete("DELETE FROM room_members WHERE id = #{id}")
    void removeMember(String id);

    @Update("UPDATE room_members SET ready = #{ready} WHERE id = #{id}")
    void setReady(@Param("id") String id, @Param("ready") boolean ready);

    @Update("UPDATE rooms SET version = version + 1 WHERE id = #{id}")
    void advanceVersion(String id);

    @Update("UPDATE rooms SET status = #{status}, version = version + 1 WHERE id = #{id}")
    void setStatus(@Param("id") String id, @Param("status") String status);

    @Insert("""
        INSERT INTO invitations (id, room_id, token_hash, role, password_hash, expires_at, max_uses)
        VALUES (#{i.id}, #{i.roomId}, #{tokenHash}, #{i.role}, #{i.passwordHash}, #{i.expiresAt}, #{i.maxUses})
        """)
    void insertInvite(@Param("i") Invite invite, @Param("tokenHash") String tokenHash);

    @Select("""
        SELECT id, room_id, role, password_hash,
            COALESCE(revoked_at, expires_at) AS expires_at, max_uses, use_count
        FROM invitations WHERE token_hash = #{hash}
        """)
    Invite invite(String hash);

    @Update("UPDATE invitations SET use_count = use_count + 1 WHERE id = #{id}")
    void consumeInvite(String id);

    @Select("SELECT " + ROUND_COLUMNS + " FROM rounds WHERE room_id = #{id} ORDER BY sequence_no DESC LIMIT 1")
    Round latestRound(String id);

    @Insert("""
        INSERT INTO rounds (id, room_id, sequence_no, stage, speaker_session_id, listener_session_id)
        VALUES (#{id}, #{room}, #{sequence}, 'TASK', #{speaker}, #{listener})
        """)
    void startRound(@Param("id") String id, @Param("room") String room, @Param("sequence") int sequence,
                    @Param("speaker") String speakerSessionId, @Param("listener") String listenerSessionId);

    @Select("SELECT room_id FROM rounds WHERE id = #{id}")
    String roundRoom(String id);

    @Update("""
        UPDATE rounds SET stage = 'SPEAKER_RECORDING', focus = #{focus},
            deadline_at = TIMESTAMPADD(SECOND, #{seconds}, CURRENT_TIMESTAMP(6)), version = version + 1
        WHERE id = #{id} AND version = #{version} AND stage = 'TASK'
        """)
    int beginRecording(@Param("id") String id, @Param("version") long version,
                       @Param("seconds") int seconds, @Param("focus") String focus);

    @Update("""
        UPDATE rounds SET deadline_at = TIMESTAMPADD(SECOND, #{seconds}, CURRENT_TIMESTAMP(6)), version = version + 1
        WHERE id = #{id} AND version = #{version}
          AND ((#{kind} = 'speaker' AND stage = 'SPEAKER_RECORDING' AND speaker_audio_id IS NULL)
            OR (#{kind} = 'listener' AND stage = 'LISTENER_RETELL' AND listener_audio_id IS NULL))
          AND (deadline_at IS NULL OR deadline_at >
        """ + RECORDING_GRACE_CUTOFF + ")")
    int restartRecording(@Param("id") String id, @Param("version") long version, @Param("seconds") int seconds,
                         @Param("kind") String kind);

    @Select("""
        SELECT id, room_id, version FROM rounds WHERE stage IN ('SPEAKER_RECORDING', 'LISTENER_RETELL') AND deadline_at <=
        """ + RECORDING_GRACE_CUTOFF + " ORDER BY deadline_at, id LIMIT 50")
    List<DueRecording> dueRecordings();

    @Update("""
        UPDATE rounds SET stage = 'CANCELLED', deadline_at = NULL, version = version + 1
        WHERE id = #{id} AND version = #{version} AND stage IN ('SPEAKER_RECORDING', 'LISTENER_RETELL') AND deadline_at <=
        """ + RECORDING_GRACE_CUTOFF)
    int expireRecording(@Param("id") String id, @Param("version") long version);

    @Update("UPDATE room_members SET role = #{role} WHERE id = #{id}")
    void setRole(@Param("id") String id, @Param("role") String role);

    @Update("UPDATE invitations SET revoked_at = CURRENT_TIMESTAMP(6) WHERE room_id = #{id} AND revoked_at IS NULL")
    void revokeInvites(String id);

    @Update("""
        UPDATE rounds SET stage = 'ARCHIVED', deadline_at = NULL, version = version + 1
        WHERE id = #{id} AND version = #{version} AND stage = 'ADVICE'
        """)
    int archive(@Param("id") String id, @Param("version") long version);

    @Update("UPDATE room_members SET ready = FALSE WHERE room_id = #{id} AND ready = TRUE")
    void resetReadiness(String id);

    @Update("""
        UPDATE rounds SET stage = 'CANCELLED', deadline_at = NULL, version = version + 1
        WHERE room_id = #{id} AND stage NOT IN ('ARCHIVED', 'CANCELLED')
        """)
    void cancelActiveRound(String id);
}
