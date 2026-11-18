package io.snailecho;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.TimeUnit;

import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

import static org.assertj.core.api.Assertions.assertThat;

@EnabledIfEnvironmentVariable(named = "ECHO_TEST_FFMPEG", matches = ".+")
class FfmpegAudioTest {
    @TempDir Path work;

    @ParameterizedTest
    @CsvSource({"m4a,aac,audio/mp4", "webm,libopus,audio/webm"})
    void convertsBrowserContainersAndTrimsToTheRoomLimit(String extension, String codec, String mime) throws Exception {
        String executable = System.getenv("ECHO_TEST_FFMPEG");
        var sample = work.resolve("sample." + extension);
        var generator = new ProcessBuilder(List.of(executable, "-nostdin", "-loglevel", "error",
                "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:a", codec, sample.toString()))
                .redirectError(ProcessBuilder.Redirect.DISCARD).start();
        try {
            assertThat(generator.waitFor(10, TimeUnit.SECONDS)).isTrue();
            assertThat(generator.exitValue()).isZero();
        } finally {
            if (generator.isAlive()) generator.destroyForcibly();
        }
        var converter = new FfmpegAudio(executable, Duration.ofSeconds(10));
        byte[] source = Files.readAllBytes(sample);
        byte[] shortMp3 = converter.mp3(source, mime, 1);
        byte[] fullMp3 = converter.mp3(source, mime, 2);
        assertThat(AudioFormat.detect(shortMp3)).isEqualTo("audio/mpeg");
        assertThat(AudioFormat.detect(fullMp3)).isEqualTo("audio/mpeg");
        assertThat(shortMp3.length).isBetween(5000, 7500);
        assertThat(fullMp3.length).isGreaterThan(shortMp3.length + 5000);
    }
}
