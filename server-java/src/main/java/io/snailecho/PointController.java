package io.snailecho;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
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
@ConditionalOnProperty(name = "echo.processing.enabled", havingValue = "true")
class PointController {
    private static final String SESSION = "echo_session";
    private final PointService points;
    private final SessionService sessions;
    private final String origin;

    PointController(PointService points, SessionService sessions, @Value("${echo.origin}") String origin) {
        this.points = points;
        this.sessions = sessions;
        this.origin = origin;
    }

    record PointInput(@NotNull @Pattern(regexp = "人物|事件|需求|情绪|因果|重点|时间") String category,
                      @NotBlank @Size(max = 200) String text) {}
    record ConfirmPoints(@NotNull @Min(1) Long expectedVersion,
                         @NotNull @Size(max = 12) List<@NotNull @Valid PointInput> points) {}
    record Aid(@NotNull @Pattern(regexp = "replay|keywords") String kind) {}

    @GetMapping("/speaker-transcript")
    ResponseEntity<PointService.Transcript> transcript(@PathVariable UUID roundId,
                                                      @CookieValue(value = SESSION, required = false) String cookie) {
        return noStore(points.speakerTranscript(roundId.toString(), sessions.require(cookie).id()));
    }

    @PostMapping("/points/confirm")
    ResponseEntity<PointService.Confirmed> confirm(@PathVariable UUID roundId, @Valid @RequestBody ConfirmPoints request,
                                                  @RequestHeader(value = "Origin", required = false) String from,
                                                  @CookieValue(value = SESSION, required = false) String cookie) {
        var input = request.points().stream().map(point -> new PointService.Point(point.category(), point.text().strip())).toList();
        return noStore(points.confirm(roundId.toString(), actor(from, cookie), request.expectedVersion(), input));
    }

    @GetMapping("/points")
    ResponseEntity<List<PointService.PointView>> list(@PathVariable UUID roundId,
                                                     @CookieValue(value = SESSION, required = false) String cookie) {
        return noStore(points.visiblePoints(roundId.toString(), sessions.require(cookie).id()));
    }

    @PostMapping("/listening-aid")
    Map<String, String> listeningAid(@PathVariable UUID roundId, @Valid @RequestBody Aid request,
                                    @RequestHeader(value = "Origin", required = false) String from,
                                    @CookieValue(value = SESSION, required = false) String cookie) {
        points.useAid(roundId.toString(), actor(from, cookie), request.kind());
        return Map.of("status", "ok");
    }

    private String actor(String from, String cookie) {
        if (!origin.equals(from)) throw new ApiFailure(403, "ORIGIN_DENIED");
        return sessions.require(cookie).id();
    }

    private static <T> ResponseEntity<T> noStore(T value) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(value);
    }
}
