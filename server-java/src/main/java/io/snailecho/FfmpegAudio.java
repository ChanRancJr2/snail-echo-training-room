package io.snailecho;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

final class FfmpegAudio {
    private static final Logger LOG = LoggerFactory.getLogger(FfmpegAudio.class);
    private static final long MAX_MP3_BYTES = 2_000_000;
    private final String executable;
    private final Duration timeout;

    FfmpegAudio(String executable, Duration timeout) {
        if (executable.isBlank()) throw new IllegalArgumentException("JAVA_FFMPEG_PATH is required");
        this.executable = executable;
        this.timeout = timeout;
    }

    byte[] mp3(byte[] audio, String mime, int seconds) {
        String demuxer = switch (mime) {
            case "audio/webm" -> "matroska";
            case "audio/mp4" -> "mov";
            case "audio/aac" -> "aac";
            case "audio/ogg" -> "ogg";
            case "audio/wav" -> "wav";
            case "audio/mpeg" -> "mp3";
            default -> throw new AsrFailure("ASR_UNSUPPORTED_AUDIO", false);
        };
        if (seconds < 1 || seconds > 300) throw new AsrFailure("ASR_INVALID_DURATION", false);
        Path directory = null;
        Path input = null;
        Path output = null;
        Process process = null;
        try {
            directory = Files.createTempDirectory("echo-asr-");
            input = Files.write(directory.resolve("source"), audio);
            output = directory.resolve("normalized.mp3");
            var command = new ArrayList<>(List.of(executable, "-nostdin", "-hide_banner", "-loglevel", "error",
                    "-max_alloc", "67108864", "-protocol_whitelist", "file", "-f", demuxer, "-threads", "1"));
            if ("mov".equals(demuxer)) command.addAll(List.of("-enable_drefs", "0"));
            command.addAll(List.of("-i", input.toString(), "-map", "0:a:0", "-map_metadata", "-1", "-map_chapters", "-1",
                    "-vn", "-sn", "-dn",
                    "-t", Integer.toString(seconds), "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame",
                    "-b:a", "48k", "-f", "mp3", output.toString()));
            process = new ProcessBuilder(command).redirectOutput(ProcessBuilder.Redirect.DISCARD)
                    .redirectError(ProcessBuilder.Redirect.DISCARD).start();
            if (!process.waitFor(timeout.toMillis(), TimeUnit.MILLISECONDS)) {
                throw new AsrFailure("ASR_TRANSCODE_TIMEOUT", false);
            }
            if (process.exitValue() != 0 || !Files.isRegularFile(output) || Files.size(output) > MAX_MP3_BYTES) {
                throw new AsrFailure("ASR_TRANSCODE_REJECTED", false);
            }
            byte[] mp3 = Files.readAllBytes(output);
            if (!"audio/mpeg".equals(AudioFormat.detect(mp3))) throw new AsrFailure("ASR_TRANSCODE_REJECTED", false);
            return mp3;
        } catch (IOException unavailable) {
            throw new AsrFailure("ASR_TRANSCODE_UNAVAILABLE", true);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new AsrFailure("ASR_TRANSCODE_INTERRUPTED", true);
        } finally {
            if (process != null && process.isAlive()) {
                process.destroyForcibly();
                try {
                    process.waitFor(2, TimeUnit.SECONDS);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
            }
            remove(output);
            remove(input);
            remove(directory);
        }
    }

    private static void remove(Path path) {
        if (path == null) return;
        try {
            Files.deleteIfExists(path);
        } catch (IOException unavailable) {
            LOG.warn("Unable to remove a local transcription temporary file");
        }
    }
}
