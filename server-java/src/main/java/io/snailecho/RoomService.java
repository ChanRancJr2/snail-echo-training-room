package io.snailecho;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.UUID;

import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;

import static io.snailecho.ApiFailure.invalid;

@Service
@Transactional(isolation = Isolation.READ_COMMITTED)
public class RoomService {
    private final RoomMapper database;
    private final BCryptPasswordEncoder passwordEncoder = new BCryptPasswordEncoder(12);

    RoomService(RoomMapper database) {
        this.database = database;
    }

    record CreateResult(State state, String inviteToken) {}
    record PublicInvite(String token, String role, int minutes, int maxUses) {}
    record Participant(String id, String nickname, String role, boolean ready) {}
    record You(String memberId, String role, boolean ready) {}
    record State(String id, String mode, String status, int durationSeconds, String retellStyle,
                 String topic, long version, String roundId, String stage, Instant deadlineAt,
                 Long roundVersion, String activeSeat, You you, List<Participant> members) {}

    public CreateResult create(String actor, String key, int seconds, String style, String topic) {
        // Lock the owning session once, so concurrent retries see the first committed room.
        if (database.lockSession(actor) == null) throw new ApiFailure(401, "UNAUTHENTICATED");
        var existing = database.createdRoom(actor, key);
        if (existing != null) {
            existing = lockRoom(existing.id());
            if (seconds != existing.durationSeconds() || !style.equals(existing.retellStyle()) || !topic.equals(existing.topic())) {
                throw new ApiFailure(409, "CREATE_KEY_REUSED");
            }
            return new CreateResult(state(existing, actor, database.members(existing.id())), null);
        }
        String id = uuid();
        database.insertRoom(id, actor, key, seconds, style, topic);
        database.insertMember(uuid(), id, actor, "speaker", null);
        var invitation = newInvite(id, "listener", 1440, 1, null);
        return new CreateResult(state(database.room(id), actor, database.members(id)), invitation.token());
    }

    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public State snapshot(String roomId, String actor) {
        var room = database.room(roomId);
        if (room == null) throw new ApiFailure(404, "ROOM_NOT_FOUND");
        return state(room, actor, database.members(roomId));
    }

    public PublicInvite invite(String roomId, String actor, String role, int minutes, int maxUses, String password) {
        var room = lockRoom(roomId);
        requireSpeaker(member(database.members(roomId), actor));
        requireWaiting(room);
        return newInvite(roomId, role, minutes, maxUses, password);
    }

    private PublicInvite newInvite(String roomId, String role, int minutes, int maxUses, String password) {
        if (password != null && password.getBytes(StandardCharsets.UTF_8).length > 72) throw invalid();
        String hash = password == null ? null : passwordEncoder.encode(password);
        String token = SessionService.newToken();
        var invitation = new RoomMapper.Invite(uuid(), roomId, role, hash, Instant.now().plus(minutes, ChronoUnit.MINUTES), maxUses, 0);
        database.insertInvite(invitation, SessionService.hash(token));
        return new PublicInvite(token, role, minutes, maxUses);
    }

    public State join(String actor, String token, String password) {
        if (!SessionService.validToken(token)) throw invalid();
        String hash = SessionService.hash(token);
        var invitation = database.invite(hash);
        if (invitation == null) throw new ApiFailure(404, "INVITE_NOT_FOUND");
        String roomId = invitation.roomId();
        var room = lockRoom(roomId);
        // Invitation counters and seats are only changed while holding the room lock.
        invitation = database.invite(hash);
        if ("CLOSED".equals(room.status())) throw new ApiFailure(410, "INVITATION_EXPIRED");
        database.removeExpiredMembers(roomId);
        var members = database.members(roomId);
        var existing = members.stream().filter(m -> m.sessionId().equals(actor)).findFirst().orElse(null);
        if (existing != null && invitation.id().equals(existing.invitationId())) return state(room, actor, members);
        if (!invitation.expiresAt().isAfter(Instant.now()) || invitation.useCount() >= invitation.maxUses()) {
            throw new ApiFailure(410, "INVITATION_EXPIRED");
        }
        String role = invitation.role();
        if (existing != null || !"WAITING".equals(room.status()) || members.stream().anyMatch(m -> m.role().equals(role))) {
            throw new ApiFailure(404, "INVITE_NOT_FOUND");
        }
        if (invitation.passwordHash() != null && (password == null || password.getBytes(StandardCharsets.UTF_8).length > 72
                || !passwordEncoder.matches(password, invitation.passwordHash()))) {
            throw new ApiFailure(403, "INVITATION_PASSWORD");
        }
        database.insertMember(uuid(), roomId, actor, role, invitation.id());
        database.consumeInvite(invitation.id());
        database.advanceVersion(roomId);
        return state(database.room(roomId), actor, database.members(roomId));
    }

    public State ready(String roomId, String actor, boolean ready) {
        var room = lockRoom(roomId);
        var member = member(database.members(roomId), actor);
        requireWaiting(room);
        if (member.ready() != ready) {
            database.setReady(member.id(), ready);
            database.advanceVersion(roomId);
        }
        return state(database.room(roomId), actor, database.members(roomId));
    }

    public State start(String roomId, String actor) {
        var room = lockRoom(roomId);
        var members = database.members(roomId);
        var speaker = member(members, actor);
        requireSpeaker(speaker);
        if ("ACTIVE".equals(room.status())) return state(room, actor, members);
        requireWaiting(room);
        boolean listenerReady = members.stream().anyMatch(m -> "listener".equals(m.role()) && m.ready());
        if (!speaker.ready() || !listenerReady) throw new ApiFailure(409, "PLAYERS_NOT_READY");
        database.startRound(uuid(), roomId);
        database.setStatus(roomId, "ACTIVE");
        return state(database.room(roomId), actor, members);
    }

    public String leave(String roomId, String actor) {
        var room = lockRoom(roomId);
        var member = member(database.members(roomId), actor);
        if ("CLOSED".equals(room.status())) return "CLOSED";
        if ("speaker".equals(member.role()) || ("listener".equals(member.role()) && "ACTIVE".equals(room.status()))) {
            database.setStatus(roomId, "CLOSED");
            return "CLOSED";
        }
        database.removeMember(member.id());
        database.advanceVersion(roomId);
        return "LEFT";
    }

    private State state(RoomMapper.Room room, String actor, List<RoomMapper.Member> members) {
        var me = member(members, actor);
        if ("CLOSED".equals(room.status())) throw new ApiFailure(404, "ROOM_CLOSED");
        var round = "ACTIVE".equals(room.status()) ? database.latestRound(room.id()) : null;
        var participants = members.stream().map(m -> new Participant(m.id(), m.nickname(), m.role(), m.ready())).toList();
        return new State(room.id(), "sync", room.status(), room.durationSeconds(), room.retellStyle(), room.topic(),
                room.version(), round == null ? null : round.id(), round == null ? null : round.stage(),
                round == null ? null : round.deadlineAt(), round == null ? null : round.version(),
                null, new You(me.id(), me.role(), me.ready()), participants);
    }

    private RoomMapper.Room lockRoom(String roomId) {
        var room = database.lockRoom(roomId);
        if (room == null) throw new ApiFailure(404, "ROOM_NOT_FOUND");
        return room;
    }

    private static RoomMapper.Member member(List<RoomMapper.Member> members, String actor) {
        return members.stream().filter(m -> m.sessionId().equals(actor)).findFirst()
                .orElseThrow(() -> new ApiFailure(403, "NOT_ROOM_MEMBER"));
    }

    private static void requireSpeaker(RoomMapper.Member member) {
        if (!"speaker".equals(member.role())) throw new ApiFailure(403, "FORBIDDEN_ROLE");
    }

    private static void requireWaiting(RoomMapper.Room room) {
        if (!"WAITING".equals(room.status())) throw new ApiFailure(409, "ROOM_NOT_WAITING");
    }

    private static String uuid() {
        return UUID.randomUUID().toString();
    }
}
