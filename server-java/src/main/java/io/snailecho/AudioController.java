package io.snailecho;

import java.util.UUID;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.CookieValue;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/rounds/{roundId}")
@ConditionalOnProperty(name = "echo.storage.enabled", havingValue = "true")
class AudioController {
    private static final String SESSION = "echo_session";
    private final AudioService audio;
    private final SessionService sessions;
    private final String origin;

    AudioController(AudioService audio, SessionService sessions, @Value("${echo.origin}") String origin) {
        this.audio = audio;
        this.sessions = sessions;
        this.origin = origin;
    }

    record UploadRequest(@NotNull @Pattern(regexp = "speaker|listener") String kind,
                         @NotNull @Size(max = 100) String mimeType,
                         @NotNull @Min(64) @Max(AudioFormat.MAX_BYTES) Integer byteSize,
                         @NotNull @Size(min = 8, max = 100) String idempotencyKey) {}

    record CommitRequest(@NotNull @Min(1) Long expectedVersion, boolean transcribe, boolean consentToTranscribe) {}

    @PostMapping("/uploads")
    ResponseEntity<AudioService.Upload> request(@PathVariable UUID roundId, @Valid @RequestBody UploadRequest request,
                                                @RequestHeader(value = "Origin", required = false) String from,
                                                @CookieValue(value = SESSION, required = false) String cookie) {
        return noStore(audio.request(roundId.toString(), actor(from, cookie), request.kind(), request.mimeType(),
                request.byteSize(), request.idempotencyKey()));
    }

    @PostMapping("/uploads/{audioId}/commit")
    ResponseEntity<AudioService.Committed> commit(@PathVariable UUID roundId, @PathVariable UUID audioId,
                                                  @Valid @RequestBody CommitRequest request,
                                                  @RequestHeader(value = "Origin", required = false) String from,
                                                  @CookieValue(value = SESSION, required = false) String cookie) {
        return noStore(audio.commit(roundId.toString(), audioId.toString(), actor(from, cookie), request.expectedVersion(),
                request.consentToTranscribe()));
    }

    @GetMapping("/audio/{audioId}/access")
    ResponseEntity<AudioService.Playback> access(@PathVariable UUID roundId, @PathVariable UUID audioId,
                                                @CookieValue(value = SESSION, required = false) String cookie) {
        return noStore(audio.access(roundId.toString(), audioId.toString(), sessions.require(cookie).id()));
    }

    private String actor(String from, String cookie) {
        if (!origin.equals(from)) throw new ApiFailure(403, "ORIGIN_DENIED");
        return sessions.require(cookie).id();
    }

    private static <T> ResponseEntity<T> noStore(T value) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(value);
    }
}
