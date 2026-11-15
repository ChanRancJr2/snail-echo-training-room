package io.snailecho;

import java.time.Instant;
import java.util.List;

import org.apache.ibatis.annotations.*;

@Mapper
interface RoomMapper {
    record Room(String id, String status, int durationSeconds, String retellStyle, String topic, long version) {}
    record Member(String id, String sessionId, String nickname, String role, boolean ready, String invitationId) {}
    record Invite(String id, String roomId, String role, String passwordHash, Instant expiresAt, int maxUses, int useCount) {}
    record Round(String id, String stage, Instant deadlineAt, long version) {}

    @Insert("INSERT INTO anonymous_sessions (id, token_hash, nickname, expires_at) VALUES (#{s.id}, #{hash}, #{s.nickname}, #{s.expiresAt})")
    void insertSession(@Param("s") SessionService.Session session, @Param("hash") String hash);

    @Select("SELECT id, nickname, expires_at FROM anonymous_sessions WHERE token_hash = #{hash}")
    SessionService.Session findSession(String hash);

    @Select("SELECT id FROM anonymous_sessions WHERE id = #{id} AND expires_at > CURRENT_TIMESTAMP(6) FOR UPDATE")
    String lockSession(String id);

    String ROOM_COLUMNS = "id, status, duration_seconds, retell_style, topic, version";

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

    @Select("SELECT id, room_id, role, password_hash, expires_at, max_uses, use_count FROM invitations WHERE token_hash = #{hash}")
    Invite invite(String hash);

    @Update("UPDATE invitations SET use_count = use_count + 1 WHERE id = #{id}")
    void consumeInvite(String id);

    @Select("SELECT id, stage, deadline_at, version FROM rounds WHERE room_id = #{id} ORDER BY sequence_no DESC LIMIT 1")
    Round latestRound(String id);

    @Insert("INSERT INTO rounds (id, room_id, sequence_no, stage) VALUES (#{id}, #{room}, 1, 'TASK')")
    void startRound(@Param("id") String id, @Param("room") String room);
}
