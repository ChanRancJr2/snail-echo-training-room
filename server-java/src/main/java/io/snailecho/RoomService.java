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
    record You(String memberId, String role, boolean ready, boolean owner) {}
    record RecordingState(String stage, Instant deadlineAt, long version) {}
    record State(String id, String mode, String status, int durationSeconds, String retellStyle,
                 String topic, long version, String roundId, String stage, Instant deadlineAt,
                 Long roundVersion, String activeSeat, String speakerAudioId, String listenerAudioId,
                 You you, List<Participant> members) {}

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
        member(database.members(roomId), actor);
        if (!actor.equals(room.ownerId())) throw new ApiFailure(403, "FORBIDDEN_ROLE");
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
        if (existing != null && invitation.id().equals(existing.invitationId())
                && invitation.role().equals(existing.role())) return state(room, actor, members);
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
        var listener = members.stream().filter(m -> "listener".equals(m.role()) && m.ready()).findFirst().orElse(null);
        if (!speaker.ready() || listener == null) throw new ApiFailure(409, "PLAYERS_NOT_READY");
        var previous = database.latestRound(roomId);
        int sequence = previous == null ? 1 : previous.sequenceNo() + 1;
        database.startRound(uuid(), roomId, sequence, speaker.sessionId(), listener.sessionId());
        database.setStatus(roomId, "ACTIVE");
        return state(database.room(roomId), actor, members);
    }

    public RecordingState beginRecording(String roundId, String actor, long expectedVersion, String focus) {
        var room = lockRecordingRoom(roundId, actor, "speaker");
        if (database.beginRecording(roundId, expectedVersion, room.durationSeconds(), focus) != 1) {
            throw new ApiFailure(409, "STALE_VERSION");
        }
        return recordingState(room.id());
    }

    public RecordingState restartRecording(String roundId, String actor, long expectedVersion, String kind) {
        var room = lockRecordingRoom(roundId, actor, kind);
        if (database.restartRecording(roundId, expectedVersion, room.durationSeconds(), kind) != 1) {
            throw new ApiFailure(409, "STALE_VERSION");
        }
        return recordingState(room.id());
    }

    private RoomMapper.Room lockRecordingRoom(String roundId, String actor, String kind) {
        String roomId = database.roundRoom(roundId);
        if (roomId == null) throw new ApiFailure(404, "ROUND_NOT_FOUND");
        var room = lockRoom(roomId);
        member(database.members(roomId), actor);
        var latest = database.latestRound(roomId);
        if (!"ACTIVE".equals(room.status()) || latest == null || !roundId.equals(latest.id())) {
            throw new ApiFailure(409, "STALE_VERSION");
        }
        String seat = "speaker".equals(kind) ? latest.speakerSessionId() : latest.listenerSessionId();
        if (!actor.equals(seat)) throw new ApiFailure(403, "FORBIDDEN_ROLE");
        return room;
    }

    private RecordingState recordingState(String roomId) {
        var updated = database.latestRound(roomId);
        return new RecordingState(updated.stage(), updated.deadlineAt(), updated.version());
    }

    public void expireRecording(RoomMapper.DueRecording due) {
        var room = lockRoom(due.roomId());
        if (!"ACTIVE".equals(room.status())) return;
        var latest = database.latestRound(room.id());
        if (latest == null || !due.id().equals(latest.id()) || database.expireRecording(due.id(), due.version()) != 1) return;
        database.resetReadiness(room.id());
        database.setStatus(room.id(), "WAITING");
    }

    public State prepareNext(String roomId, String actor, String roundId, long expectedVersion) {
        var room = lockRoom(roomId);
        var members = database.members(roomId);
        member(members, actor);
        if ("CLOSED".equals(room.status())) throw new ApiFailure(404, "ROOM_CLOSED");
        var latest = database.latestRound(roomId);
        if (latest == null || !roundId.equals(latest.id())) throw new ApiFailure(409, "STALE_VERSION");
        if (!actor.equals(latest.speakerSessionId())) throw new ApiFailure(403, "FORBIDDEN_ROLE");
        if ("WAITING".equals(room.status()) && "ARCHIVED".equals(latest.stage())
                && (latest.version() == expectedVersion || latest.version() - 1 == expectedVersion)) {
            return state(room, actor, members);
        }
        if (!"ACTIVE".equals(room.status())) throw new ApiFailure(409, "WRONG_STAGE");
        if (latest.version() != expectedVersion) throw new ApiFailure(409, "STALE_VERSION");
        if (!"ARCHIVED".equals(latest.stage()) && database.archive(roundId, expectedVersion) != 1) {
            throw new ApiFailure(409, "WRONG_STAGE");
        }
        database.resetReadiness(roomId);
        database.setStatus(roomId, "WAITING");
        return state(database.room(roomId), actor, database.members(roomId));
    }

    public State swapSeats(String roomId, String actor, long expectedVersion) {
        var room = lockRoom(roomId);
        var members = database.members(roomId);
        member(members, actor);
        if (!actor.equals(room.ownerId())) throw new ApiFailure(403, "FORBIDDEN_ROLE");
        if (room.version() != expectedVersion) throw new ApiFailure(409, "STALE_VERSION");
        requireWaiting(room);
        var latest = database.latestRound(roomId);
        if (latest == null || !"ARCHIVED".equals(latest.stage())) throw new ApiFailure(409, "WRONG_STAGE");
        var speaker = members.stream().filter(m -> "speaker".equals(m.role())).findFirst().orElse(null);
        var listener = members.stream().filter(m -> "listener".equals(m.role())).findFirst().orElse(null);
        if (speaker == null || listener == null) throw new ApiFailure(409, "PLAYERS_NOT_READY");

        // Hold the room lock and keep the unique role constraint through all three updates.
        database.setRole(speaker.id(), "swapping");
        database.setRole(listener.id(), "speaker");
        database.setRole(speaker.id(), "listener");
        database.resetReadiness(roomId);
        database.revokeInvites(roomId);
        database.advanceVersion(roomId);
        return state(database.room(roomId), actor, database.members(roomId));
    }

    public String leave(String roomId, String actor) {
        var room = lockRoom(roomId);
        var member = member(database.members(roomId), actor);
        if ("CLOSED".equals(room.status())) return "CLOSED";
        if (actor.equals(room.ownerId()) || (!"observer".equals(member.role()) && "ACTIVE".equals(room.status()))) {
            database.cancelActiveRound(roomId);
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
        var round = database.latestRound(room.id());
        var participants = members.stream().map(m -> new Participant(m.id(), m.nickname(), m.role(), m.ready())).toList();
        return new State(room.id(), "sync", room.status(), room.durationSeconds(), room.retellStyle(), room.topic(),
                room.version(), round == null ? null : round.id(), round == null ? null : round.stage(),
                round == null ? null : round.deadlineAt(), round == null ? null : round.version(),
                null, round == null ? null : round.speakerAudioId(), round == null ? null : round.listenerAudioId(),
                new You(me.id(), me.role(), me.ready(), actor.equals(room.ownerId())), participants);
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
