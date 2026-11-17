package io.snailecho;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

import com.fasterxml.jackson.annotation.JsonIgnore;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;

import static io.snailecho.ApiFailure.invalid;

@Service
@Transactional(isolation = Isolation.READ_COMMITTED)
public class RoomService {
    private static final Set<String> ASYNC_INVITABLE = Set.of("TASK", "SPEAKER_RECORDING", "KEYPOINT_CONFIRM", "ASYNC_PENDING");
    private final RoomMapper database;
    private final Optional<ComparisonService> comparisons;
    private final BCryptPasswordEncoder passwordEncoder = new BCryptPasswordEncoder(12);

    RoomService(RoomMapper database, Optional<ComparisonService> comparisons) {
        this.database = database;
        this.comparisons = comparisons;
    }

    record CreateResult(State state, String inviteToken, @JsonIgnore boolean created) {}
    record Teen(String nickname, String role, String reportRole) {}
    record PublicInvite(String token, String role, int minutes, int maxUses) {}
    record Participant(String id, String nickname, String role, boolean ready) {}
    record You(String memberId, String role, boolean ready, boolean owner) {}
    record RecordingState(String stage, Instant deadlineAt, long version) {}
    record State(String id, String mode, String status, int durationSeconds, String retellStyle,
                 String topic, long version, String roundId, String stage, Instant deadlineAt,
                 Long roundVersion, String activeSeat, String speakerAudioId, String listenerAudioId,
                 You you, List<Participant> members, String terminalReason, ComparisonService.Practice previousPractice,
                 String reportRole, Teen teen) {}

    public CreateResult create(String actor, String key, String mode, int seconds, String style, String topic,
                               String teenNickname, String teenRole) {
        // Lock the owning session once, so concurrent retries see the first committed room.
        if (database.lockSession(actor) == null) throw new ApiFailure(401, "UNAUTHENTICATED");
        var existing = database.createdRoom(actor, key);
        if (existing != null) {
            existing = lockRoom(existing.id());
            String firstTeenRole = existing.teenRole() == null ? null : database.initialTeenRole(existing.id());
            if (firstTeenRole == null) firstTeenRole = existing.teenRole();
            if (seconds != existing.durationSeconds() || !style.equals(existing.retellStyle()) || !topic.equals(existing.topic())
                    || !mode.equals(existing.mode()) || !Objects.equals(teenNickname, existing.teenNickname())
                    || !Objects.equals(teenRole, firstTeenRole)) {
                throw new ApiFailure(409, "CREATE_KEY_REUSED");
            }
            return new CreateResult(state(existing, actor, database.members(existing.id())), null, false);
        }
        String id = uuid();
        database.insertRoom(id, actor, key, seconds, style, topic, mode, teenNickname, teenRole);
        database.insertMember(uuid(), id, actor, "speaker", null);
        var invitation = sameDevice(mode) ? null : newInvite(id, "listener", 1440, 1, null);
        return new CreateResult(state(database.room(id), actor, database.members(id)),
                invitation == null ? null : invitation.token(), true);
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
        if (sameDevice(room.mode()) || ("async".equals(room.mode()) && !"listener".equals(role))) {
            throw new ApiFailure(403, "INVITE_UNAVAILABLE");
        }
        if (!canInvite(room)) throw new ApiFailure(409, "ROOM_NOT_WAITING");
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
        if (existing != null || !canInvite(room) || members.stream().anyMatch(m -> m.role().equals(role))) {
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
        String listener = null;
        if (sameDevice(room.mode())) {
            if (!speaker.ready()) throw new ApiFailure(409, "PLAYERS_NOT_READY");
            listener = actor;
        } else if ("sync".equals(room.mode())) {
            var readyListener = members.stream().filter(m -> "listener".equals(m.role()) && m.ready()).findFirst().orElse(null);
            if (!speaker.ready() || readyListener == null) throw new ApiFailure(409, "PLAYERS_NOT_READY");
            listener = readyListener.sessionId();
        }
        var previous = database.latestRound(roomId);
        int sequence = previous == null ? 1 : previous.sequenceNo() + 1;
        database.startRound(uuid(), roomId, sequence, speaker.sessionId(), listener, room.teenRole());
        database.setStatus(roomId, "ACTIVE");
        return state(database.room(roomId), actor, members);
    }

    public RecordingState openMessage(String roundId, String actor, long expectedVersion) {
        String roomId = database.roundRoom(roundId);
        if (roomId == null) throw new ApiFailure(404, "ROUND_NOT_FOUND");
        var room = lockRoom(roomId);
        var listener = member(database.members(roomId), actor);
        if (!"async".equals(room.mode()) || !"listener".equals(listener.role())) {
            throw new ApiFailure(403, "FORBIDDEN_ROLE");
        }
        var round = database.latestRound(roomId);
        if (!"ACTIVE".equals(room.status()) || round == null || !roundId.equals(round.id())) {
            throw new ApiFailure(409, "STALE_VERSION");
        }
        if ("LISTENER_RETELL".equals(round.stage()) && actor.equals(round.listenerSessionId())
                && round.version() - 1 == expectedVersion) {
            return recordingState(round);
        }
        if (database.openMessage(roundId, expectedVersion, actor) != 1) {
            throw new ApiFailure(409, "STALE_VERSION");
        }
        return recordingState(roomId);
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
        return recordingState(database.latestRound(roomId));
    }

    private static RecordingState recordingState(RoomMapper.Round updated) {
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
        if (!"ADVICE".equals(latest.stage()) || database.archive(roundId, expectedVersion) != 1) {
            throw new ApiFailure(409, "WRONG_STAGE");
        }
        if ("sync".equals(room.mode())) exchangeRoles(roomId, members);
        if ("teen".equals(room.mode())) {
            database.setTeenRole(roomId, "speaker".equals(room.teenRole()) ? "listener" : "speaker");
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
        if (!"sync".equals(room.mode())) throw new ApiFailure(409, "WRONG_STAGE");
        if (room.version() != expectedVersion) throw new ApiFailure(409, "STALE_VERSION");
        requireWaiting(room);
        var latest = database.latestRound(roomId);
        if (latest == null || !"ARCHIVED".equals(latest.stage())) throw new ApiFailure(409, "WRONG_STAGE");
        if (members.stream().anyMatch(m -> "speaker".equals(m.role()) && m.sessionId().equals(latest.listenerSessionId()))) {
            throw new ApiFailure(409, "SEATS_ALREADY_SWAPPED");
        }
        exchangeRoles(roomId, members);
        database.resetReadiness(roomId);
        database.advanceVersion(roomId);
        return state(database.room(roomId), actor, database.members(roomId));
    }

    private void exchangeRoles(String roomId, List<RoomMapper.Member> members) {
        var speaker = members.stream().filter(m -> "speaker".equals(m.role())).findFirst().orElse(null);
        var listener = members.stream().filter(m -> "listener".equals(m.role())).findFirst().orElse(null);
        if (speaker == null || listener == null) throw new ApiFailure(409, "PLAYERS_NOT_READY");

        // Hold the room lock and keep the unique role constraint through all three updates.
        database.setRole(speaker.id(), "swapping");
        database.setRole(listener.id(), "speaker");
        database.setRole(speaker.id(), "listener");
        database.revokeInvites(roomId);
    }

    public String leave(String roomId, String actor) {
        var room = lockRoom(roomId);
        var member = member(database.members(roomId), actor);
        if ("CLOSED".equals(room.status())) return "CLOSED";
        boolean joinedRound = !"observer".equals(member.role()) && "ACTIVE".equals(room.status())
                && (!"async".equals(room.mode()) || !canInvite(room));
        if (actor.equals(room.ownerId()) || joinedRound) {
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
        boolean archived = round != null && "ARCHIVED".equals(round.stage());
        String reportRole = !archived ? null : actor.equals(round.speakerSessionId()) ? "speaker"
                : actor.equals(round.listenerSessionId()) ? "listener" : "observer".equals(me.role()) ? "observer" : null;
        if (archived && reportRole == null) {
            round = null;
        }
        var previousPractice = round != null && "TASK".equals(round.stage()) && "speaker".equals(me.role())
                ? comparisons.map(service -> service.previousPractice(room.id(), actor)).orElse(null) : null;
        var participants = members.stream().map(m -> new Participant(m.id(), m.nickname(), m.role(), m.ready())).toList();
        var teen = room.teenRole() == null ? null : new Teen(room.teenNickname(), room.teenRole(),
                archived && round != null ? round.teenRole() : null);
        String activeSeat = round == null || !sameDevice(room.mode()) ? null
                : "LISTENER_RETELL".equals(round.stage()) ? "listener" : "speaker";
        boolean canReadSpeakerAudio = round != null && !archived
                && (!"async".equals(room.mode()) || actor.equals(round.speakerSessionId()) || actor.equals(round.listenerSessionId()));
        return new State(room.id(), room.mode(), room.status(), room.durationSeconds(), room.retellStyle(), room.topic(),
                room.version(), round == null ? null : round.id(), round == null ? null : round.stage(),
                round == null ? null : round.deadlineAt(), round == null ? null : round.version(),
                activeSeat, canReadSpeakerAudio ? round.speakerAudioId() : null, round == null || archived ? null : round.listenerAudioId(),
                new You(me.id(), me.role(), me.ready(), actor.equals(room.ownerId())), participants,
                round == null ? null : round.terminalReason(), previousPractice, reportRole, teen);
    }

    static boolean sameDevice(String mode) {
        return "solo".equals(mode) || "teen".equals(mode);
    }

    private boolean canInvite(RoomMapper.Room room) {
        if ("WAITING".equals(room.status())) return true;
        if (!"async".equals(room.mode()) || !"ACTIVE".equals(room.status())) return false;
        var round = database.latestRound(room.id());
        return round != null && ASYNC_INVITABLE.contains(round.stage());
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
