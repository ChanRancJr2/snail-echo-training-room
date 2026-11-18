package io.snailecho;

import java.time.Instant;
import java.util.concurrent.Semaphore;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Service;

@Service
@ConditionalOnProperty(name = "echo.storage.enabled", havingValue = "true")
class AudioService {
    private final AudioTransactions transactions;
    private final S3AudioStorage storage;
    private final Semaphore transfers = new Semaphore(4);

    AudioService(AudioTransactions transactions, S3AudioStorage storage) {
        this.transactions = transactions;
        this.storage = storage;
    }

    record Upload(String audioId, String status, String uploadUrl) {}
    record RoundView(String id, String stage, long version, Instant deadlineAt, String speakerAudioId, String listenerAudioId) {}
    record Committed(String audioId, String status, RoundView round) {}
    record Playback(String url, int expiresIn) {}

    Upload request(String roundId, String actor, String kind, String rawMime, int bytes, String key) {
        String mime = AudioFormat.mime(rawMime);
        if (mime == null) throw new ApiFailure(400, "INVALID_AUDIO");
        var asset = transactions.request(roundId, actor, kind, mime, bytes, key);
        return asset.objectKey() == null
                ? new Upload(asset.id(), "PENDING", storage.uploadUrl(asset))
                : new Upload(asset.id(), "COMMITTED", null);
    }

    Committed commit(String roundId, String audioId, String actor, long version, boolean consent) {
        var prepared = transactions.prepare(roundId, audioId, actor, version, consent);
        if (prepared.asset().objectKey() != null) return result(prepared);
        if (!transfers.tryAcquire()) throw new ApiFailure(503, "AUDIO_STORAGE_BUSY");
        try {
            String candidate = storage.seal(prepared.asset());
            AudioTransactions.Confirmation committed;
            try {
                committed = transactions.finish(roundId, audioId, actor, version, consent, candidate);
            } catch (ApiFailure rejected) {
                storage.discard(candidate);
                throw rejected;
            }
            // A lost DB connection can leave the commit outcome unknown. A future reconciliation job
            // must check references before deleting an object from an ambiguous commit.
            if (!candidate.equals(committed.asset().objectKey())) storage.discard(candidate);
            return result(committed);
        } finally {
            transfers.release();
        }
    }

    Playback access(String roundId, String audioId, String actor) {
        String key = transactions.access(roundId, audioId, actor);
        return new Playback(storage.downloadUrl(key), S3AudioStorage.DOWNLOAD_SECONDS);
    }

    private static Committed result(AudioTransactions.Confirmation confirmation) {
        var round = confirmation.round();
        return new Committed(confirmation.asset().id(), "COMMITTED", new RoundView(round.id(), round.stage(),
                round.version(), round.deadlineAt(), round.speakerAudioId(), round.listenerAudioId()));
    }
}
