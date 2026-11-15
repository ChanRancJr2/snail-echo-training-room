package io.snailecho;

import java.util.UUID;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;

@Service
@ConditionalOnProperty(name = "echo.storage.enabled", havingValue = "true")
@Transactional(isolation = Isolation.READ_COMMITTED)
class AudioTransactions {
    private final RoomMapper rooms;
    private final AudioMapper audio;
    private final TranscriptionMapper jobs;

    AudioTransactions(RoomMapper rooms, AudioMapper audio, TranscriptionMapper jobs) {
        this.rooms = rooms;
        this.audio = audio;
        this.jobs = jobs;
    }

    record Confirmation(AudioMapper.Asset asset, RoomMapper.Round round) {}

    public AudioMapper.Asset request(String roundId, String actor, String kind, String mime, int size, String key) {
        var round = lockActiveRound(roundId, actor);
        checkSeat(round, actor, kind);
        var previous = audio.byKey(roundId, kind, key);
        if (previous != null && (!mime.equals(previous.mimeType()) || size != previous.byteSize())) {
            throw new ApiFailure(409, "UPLOAD_KEY_REUSED");
        }
        var winner = audio.committed(roundId, kind);
        if (winner != null) return winner;
        if (previous != null && previous.roundVersion() != round.version()) throw new ApiFailure(409, "STALE_AUDIO");
        checkStage(round, kind);
        if (previous != null) return previous;
        if (audio.count(roundId, kind) >= 32) throw new ApiFailure(429, "UPLOAD_LIMIT_REACHED");
        var asset = new AudioMapper.Asset(UUID.randomUUID().toString(), roundId, actor, kind, mime, size,
                round.version(), null);
        audio.insert(asset, key);
        return asset;
    }

    public Confirmation prepare(String roundId, String audioId, String actor, long version, boolean consent) {
        var round = lockActiveRound(roundId, actor);
        return checkCommit(round, audioId, actor, version, consent);
    }

    public Confirmation finish(String roundId, String audioId, String actor, long version, boolean consent, String objectKey) {
        var round = lockActiveRound(roundId, actor);
        var eligible = checkCommit(round, audioId, actor, version, consent);
        var asset = eligible.asset();
        if (asset.objectKey() != null) return eligible;
        int changed = "speaker".equals(asset.kind())
                ? audio.commitSpeaker(roundId, audioId, version)
                : audio.commitListener(roundId, audioId, version);
        if (changed != 1 || audio.seal(audioId, objectKey) != 1) throw new ApiFailure(409, "STALE_AUDIO");
        jobs.enqueue(audioId, roundId);
        String roomId = rooms.roundRoom(roundId);
        rooms.advanceVersion(roomId);
        return new Confirmation(audio.byId(roundId, audioId), rooms.latestRound(roomId));
    }

    private Confirmation checkCommit(RoomMapper.Round round, String audioId, String actor, long version, boolean consent) {
        var asset = audio.byId(round.id(), audioId);
        if (asset == null) throw new ApiFailure(404, "AUDIO_NOT_FOUND");
        checkSeat(round, actor, asset.kind());
        if (!asset.sessionId().equals(actor)) throw new ApiFailure(403, "AUDIO_NOT_OWNED");
        var winner = audio.committed(round.id(), asset.kind());
        if (winner != null) return new Confirmation(winner, round);
        if (asset.roundVersion() != round.version() || version != round.version()) {
            throw new ApiFailure(409, "STALE_AUDIO");
        }
        checkStage(round, asset.kind());
        if ("listener".equals(asset.kind()) && !consent) throw new ApiFailure(400, "CONSENT_REQUIRED");
        return new Confirmation(asset, round);
    }

    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public String access(String roundId, String audioId, String actor) {
        String roomId = rooms.roundRoom(roundId);
        if (roomId == null) throw inaccessible();
        var room = rooms.room(roomId);
        var member = rooms.members(roomId).stream().filter(m -> actor.equals(m.sessionId())).findFirst().orElse(null);
        var round = audio.round(roundId);
        var asset = audio.byId(roundId, audioId);
        if (room == null || member == null || round == null || asset == null || asset.objectKey() == null) throw inaccessible();
        boolean participant = actor.equals(round.speakerSessionId()) || actor.equals(round.listenerSessionId());
        if ("ARCHIVED".equals(round.stage()) && participant) return asset.objectKey();
        if (!"ACTIVE".equals(room.status()) || !roundId.equals(rooms.latestRound(roomId).id())) throw inaccessible();
        boolean speakerAudio = "speaker".equals(asset.kind());
        boolean allowed = switch (round.stage()) {
            case "KEYPOINT_CONFIRM" -> speakerAudio && actor.equals(round.speakerSessionId());
            case "LISTENER_RETELL", "COMPARING" -> speakerAudio && (participant || "observer".equals(member.role()));
            case "SPEAKER_LABELING", "MUTUAL_CONFIRM", "ADVICE" -> participant || "observer".equals(member.role());
            default -> false;
        };
        if (!allowed) throw inaccessible();
        return asset.objectKey();
    }

    private RoomMapper.Round lockActiveRound(String roundId, String actor) {
        String roomId = rooms.roundRoom(roundId);
        if (roomId == null) throw new ApiFailure(404, "ROUND_NOT_FOUND");
        var room = rooms.lockRoom(roomId);
        if (rooms.members(roomId).stream().noneMatch(m -> actor.equals(m.sessionId()))) {
            throw new ApiFailure(403, "NOT_ROOM_MEMBER");
        }
        var round = rooms.latestRound(roomId);
        if (!"ACTIVE".equals(room.status()) || round == null || !roundId.equals(round.id())) {
            throw new ApiFailure(409, "ROOM_NOT_ACTIVE");
        }
        return round;
    }

    private static void checkSeat(RoomMapper.Round round, String actor, String kind) {
        String sessionId = "speaker".equals(kind) ? round.speakerSessionId() : round.listenerSessionId();
        if (!actor.equals(sessionId)) throw new ApiFailure(403, "FORBIDDEN_ROLE");
    }

    private void checkStage(RoomMapper.Round round, String kind) {
        String expected = "speaker".equals(kind) ? "SPEAKER_RECORDING" : "LISTENER_RETELL";
        if (!expected.equals(round.stage())) throw new ApiFailure(409, "WRONG_STAGE");
        if (audio.recordingWindowOpen(round.id()) != 1) throw new ApiFailure(409, "RECORDING_WINDOW_CLOSED");
    }

    private static ApiFailure inaccessible() {
        return new ApiFailure(403, "AUDIO_NOT_ACCESSIBLE");
    }
}
