package io.snailecho;

import java.util.List;
import java.util.Optional;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

final class VolcTranscription {
    private static final Logger LOG = LoggerFactory.getLogger(VolcTranscription.class);
    private final TranscriptionQueue queue;
    private final S3AudioStorage storage;
    private final FfmpegAudio ffmpeg;
    private final VolcFileAsr asr;
    private final Optional<ArkComparison> ark;

    VolcTranscription(TranscriptionQueue queue, S3AudioStorage storage,
                      FfmpegAudio ffmpeg, VolcFileAsr asr, Optional<ArkComparison> ark) {
        this.queue = queue;
        this.storage = storage;
        this.ffmpeg = ffmpeg;
        this.asr = asr;
        this.ark = ark;
    }

    void process(TranscriptionQueue.Lease lease, AudioMapper.Asset asset) {
        var progress = queue.progress(lease);
        if (progress == null) return;
        if (progress.expired()) throw new AsrFailure("VOLC_POLL_DEADLINE", false);
        if (progress.startedAt() == null) {
            submit(lease, asset);
            return;
        }
        // The client UUID is the only identifier available when the submit response was lost.
        String taskId = progress.taskId() == null ? lease.audioId() : progress.taskId();
        var response = asr.query(taskId);
        if (response.pending()) queue.defer(lease, taskId);
        else if ("speaker".equals(asset.kind())) queue.complete(lease, response.text(), candidates(lease, response.text()));
        else queue.complete(lease, response.text());
    }

    private List<PointService.Point> candidates(TranscriptionQueue.Lease lease, String transcript) {
        if (ark.isEmpty()) return List.of();
        try {
            return ArkComparison.retryTransient(() -> ark.get().extract(transcript));
        } catch (ArkComparison.Failure failure) {
            LOG.warn("Candidate extraction failed for audio {} ({})", lease.audioId(), failure.getMessage());
            return List.of();
        }
    }

    private void submit(TranscriptionQueue.Lease lease, AudioMapper.Asset asset) {
        byte[] original = storage.readCommitted(asset);
        byte[] normalized = ffmpeg.mp3(original, asset.mimeType(), queue.durationSeconds(lease));
        if (!queue.reserveArtifact(lease)) return;
        String signedUrl = storage.stageForAsr(S3AudioStorage.asrKey(lease.audioId()), normalized);
        if (!queue.startProvider(lease)) return;
        String taskId = asr.submit(lease.audioId(), signedUrl);
        queue.defer(lease, taskId);
    }

}
