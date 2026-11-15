package io.snailecho;

final class VolcTranscription {
    private final TranscriptionQueue queue;
    private final S3AudioStorage storage;
    private final FfmpegAudio ffmpeg;
    private final VolcFileAsr asr;

    VolcTranscription(TranscriptionQueue queue, S3AudioStorage storage,
                      FfmpegAudio ffmpeg, VolcFileAsr asr) {
        this.queue = queue;
        this.storage = storage;
        this.ffmpeg = ffmpeg;
        this.asr = asr;
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
        else queue.complete(lease, response.text());
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
