package io.snailecho;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;

@Service
@ConditionalOnProperty(name = "echo.processing.enabled", havingValue = "true")
@Transactional(isolation = Isolation.READ_COMMITTED)
class PointService {
    private final RoomMapper rooms;
    private final PointMapper points;
    private final TranscriptionMapper jobs;
    private final TextVault vault;

    PointService(RoomMapper rooms, PointMapper points, TranscriptionMapper jobs, TextVault vault) {
        this.rooms = rooms;
        this.points = points;
        this.jobs = jobs;
        this.vault = vault;
    }

    record Point(String category, String text) {}
    record PointView(String id, int position, String category, String text) {}
    record RoundView(String id, String stage, long version, Instant deadlineAt) {}
    record Confirmed(RoundView round, List<PointView> points) {}
    record Transcript(String status, String text, List<Point> candidates) {}
    private record ActiveRound(RoomMapper.Room room, RoomMapper.Round round, String memberRole) {}

    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public Transcript speakerTranscript(String roundId, String actor) {
        var round = activeRound(roundId, actor, false).round();
        if (!actor.equals(round.speakerSessionId()) || !"KEYPOINT_CONFIRM".equals(round.stage())) {
            throw new ApiFailure(403, "TRANSCRIPT_NOT_ACCESSIBLE");
        }
        if (round.speakerAudioId() == null) throw new ApiFailure(409, "AUDIO_UNAVAILABLE");
        var job = jobs.byId(round.speakerAudioId());
        if (job == null) return new Transcript("failed", null, List.of());
        return switch (job.status()) {
            case "DONE" -> new Transcript("ready", vault.open("transcript:" + job.audioId(), job.resultCiphertext()), List.of());
            case "FAILED", "CANCELLED" -> new Transcript("failed", null, List.of());
            default -> new Transcript("pending", null, List.of());
        };
    }

    public Confirmed confirm(String roundId, String actor, long version, List<Point> input) {
        var active = activeRound(roundId, actor, true);
        var round = active.round();
        if (!actor.equals(round.speakerSessionId())) throw new ApiFailure(403, "FORBIDDEN_ROLE");
        String nextStage = "async".equals(active.room().mode()) ? "ASYNC_PENDING" : "LISTENER_RETELL";
        if (nextStage.equals(round.stage()) && version + 1 == round.version()) {
            var saved = readPoints(roundId, false);
            if (saved.stream().map(p -> new Point(p.category(), p.text())).toList().equals(input)) {
                return result(round, saved);
            }
        }
        if (points.confirm(roundId, version, nextStage) != 1) throw new ApiFailure(409, "STALE_VERSION");
        var saved = new ArrayList<PointView>(input.size());
        for (var point : input) {
            String id = UUID.randomUUID().toString();
            int position = saved.size();
            points.insert(roundId, new PointMapper.StoredPoint(id, position, point.category(),
                    vault.seal("point:" + id, point.text())));
            saved.add(new PointView(id, position, point.category(), point.text()));
        }
        rooms.advanceVersion(active.room().id());
        return result(rooms.latestRound(active.room().id()), saved);
    }

    public void useAid(String roundId, String actor, String kind) {
        var active = activeRound(roundId, actor, true);
        var round = active.round();
        if (!actor.equals(round.listenerSessionId()) || !"LISTENER_RETELL".equals(round.stage())
                || ("keywords".equals(kind) && !"keywords".equals(active.room().retellStyle()))) {
            throw new ApiFailure(403, "AID_NOT_ACCESSIBLE");
        }
        points.recordAid(roundId, kind);
    }

    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public List<PointView> visiblePoints(String roundId, String actor) {
        var active = activeRound(roundId, actor, false);
        var round = active.round();
        boolean retelling = "LISTENER_RETELL".equals(round.stage());
        boolean listening = retelling && actor.equals(round.listenerSessionId());
        boolean observing = retelling && "observer".equals(active.memberRole());
        if (!listening && actor.equals(round.speakerSessionId())) return readPoints(roundId, false);
        if (!"keywords".equals(active.room().retellStyle())
                || !(observing || listening && points.keywordsUsed(roundId))) {
            throw new ApiFailure(403, "POINTS_HIDDEN");
        }
        return readPoints(roundId, true);
    }

    private List<PointView> readPoints(String roundId, boolean hints) {
        return points.list(roundId).stream().map(row -> {
            String content = vault.open("point:" + row.id(), row.contentCiphertext());
            if (hints && content.codePointCount(0, content.length()) > 6) {
                content = content.substring(0, content.offsetByCodePoints(0, 6)) + "…";
            }
            return new PointView(row.id(), row.position(), row.category(), content);
        }).toList();
    }

    private ActiveRound activeRound(String roundId, String actor, boolean lock) {
        String roomId = rooms.roundRoom(roundId);
        if (roomId == null) throw new ApiFailure(404, "ROUND_NOT_FOUND");
        var room = lock ? rooms.lockRoom(roomId) : rooms.room(roomId);
        var member = rooms.members(roomId).stream().filter(seat -> actor.equals(seat.sessionId()))
                .findFirst().orElseThrow(() -> new ApiFailure(403, "NOT_ROOM_MEMBER"));
        var round = rooms.latestRound(roomId);
        if (room == null || !"ACTIVE".equals(room.status()) || round == null || !roundId.equals(round.id())) {
            throw new ApiFailure(409, "ROOM_NOT_ACTIVE");
        }
        return new ActiveRound(room, round, member.role());
    }

    private static Confirmed result(RoomMapper.Round round, List<PointView> saved) {
        return new Confirmed(new RoundView(round.id(), round.stage(), round.version(), round.deadlineAt()), saved);
    }
}
