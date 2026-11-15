package io.snailecho;

import java.util.UUID;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;

@Service
@ConditionalOnProperty(name = "echo.processing.enabled", havingValue = "true")
@Transactional(isolation = Isolation.READ_COMMITTED)
class TranscriptionQueue {
    private final TranscriptionMapper jobs;
    private final RoomMapper rooms;
    private final AudioMapper audio;
    private final TextVault text;

    TranscriptionQueue(TranscriptionMapper jobs, RoomMapper rooms, AudioMapper audio, TextVault text) {
        this.jobs = jobs;
        this.rooms = rooms;
        this.audio = audio;
        this.text = text;
    }

    record Lease(String audioId, String roundId, String token) {}

    public Lease claim() {
        var job = jobs.due();
        if (job == null) return null;
        if (job.attempts() >= 3) {
            jobs.exhausted(job.audioId());
            return null;
        }
        String token = UUID.randomUUID().toString();
        jobs.lease(job.audioId(), token);
        return new Lease(job.audioId(), job.roundId(), token);
    }

    public boolean complete(Lease lease, String transcript) {
        if (!stillRelevant(lease)) return cancel(lease);
        return jobs.succeed(lease.audioId(), lease.token(), text.seal("transcript:" + lease.audioId(), transcript)) == 1;
    }

    private boolean stillRelevant(Lease lease) {
        String roomId = rooms.roundRoom(lease.roundId());
        var room = roomId == null ? null : rooms.lockRoom(roomId);
        if (room == null || !"ACTIVE".equals(room.status())) return false;
        var round = rooms.latestRound(roomId);
        return round != null && lease.roundId().equals(round.id()) && accepts(round, lease.audioId());
    }

    public boolean retry(Lease lease) {
        return jobs.retry(lease.audioId(), lease.token()) == 1;
    }

    public AudioMapper.Asset source(Lease lease) {
        if (!stillRelevant(lease)) {
            cancel(lease);
            return null;
        }
        if (jobs.owned(lease.audioId(), lease.token()) != 1) return null;
        return audio.byId(lease.roundId(), lease.audioId());
    }

    private boolean cancel(Lease lease) {
        jobs.cancel(lease.audioId(), lease.token());
        return false;
    }

    private static boolean accepts(RoomMapper.Round round, String audioId) {
        if (audioId.equals(round.listenerAudioId())) return "COMPARING".equals(round.stage());
        return audioId.equals(round.speakerAudioId()) && switch (round.stage()) {
            case "KEYPOINT_CONFIRM", "LISTENER_RETELL", "COMPARING" -> true;
            default -> false;
        };
    }
}
