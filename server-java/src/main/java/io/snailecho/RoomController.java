package io.snailecho;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseCookie;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import static io.snailecho.ApiFailure.invalid;

@RestController
class RoomController {
    private static final String SESSION = "echo_session";
    private static final java.util.regex.Pattern NICKNAME =
            java.util.regex.Pattern.compile("(?Us)\\A[\\s\\uFEFF]*+(.{1,20}?)[\\s\\uFEFF]*+\\z");
    private final RoomService rooms;
    private final SessionService sessions;
    private final String origin;

    RoomController(RoomService rooms, SessionService sessions, @Value("${echo.origin}") String origin) {
        this.rooms = rooms;
        this.sessions = sessions;
        this.origin = origin;
    }

    record TeenInput(@Size(max = 12) String nickname,
                     @NotNull @Pattern(regexp = "speaker|listener") String role) {}
    record CreateRequest(@NotNull @Pattern(regexp = "sync|solo|teen|async") String mode,
                         @NotNull @Size(min = 8, max = 100) String createKey,
                         Integer durationSeconds, @Pattern(regexp = "auditory|keywords") String retellStyle,
                         @Size(max = 80) String topic, @Valid TeenInput teen) {}
    record InviteRequest(@NotNull @Pattern(regexp = "listener|observer") String role,
                         @NotNull @Min(0) @Max(10080) Integer minutes,
                         @NotNull @Min(1) @Max(10) Integer maxUses,
                         @Size(min = 6, max = 100) String password) {}
    record JoinRequest(@NotNull String token, @Size(max = 100) String password) {}
    record ReadyRequest(@NotNull Boolean ready) {}
    record NextRoundRequest(@NotNull UUID roundId, @NotNull @Min(1) Long expectedVersion) {}
    record VersionRequest(@NotNull @Min(1) Long expectedVersion) {}
    record TaskRequest(@NotNull @Min(1) Long expectedVersion, @Size(max = 80) String focus) {}
    record RestartRequest(@NotNull @Min(1) Long expectedVersion,
                          @NotNull @Pattern(regexp = "speaker|listener") String kind) {}

    @GetMapping("/health/live")
    Map<String, String> live() {
        return Map.of("status", "ok");
    }

    @PostMapping("/api/sessions/anonymous")
    ResponseEntity<SessionService.Session> session(@RequestHeader(value = "Origin", required = false) String from,
                                                   @CookieValue(value = SESSION, required = false) String token,
                                                   @RequestBody JsonNode request) {
        checkOrigin(from);
        if (!request.isObject() || (request.size() != 0 && (request.size() != 1 || !request.has("nickname")))) {
            throw invalid();
        }
        String nickname = null;
        if (request.has("nickname")) {
            var name = request.get("nickname");
            if (!name.isTextual()) throw invalid();
            var trimmed = NICKNAME.matcher(name.textValue());
            if (!trimmed.matches()) throw invalid();
            nickname = trimmed.group(1);
            if (nickname.length() > 20 || nickname.indexOf('\0') >= 0) throw invalid();
        }
        var issued = sessions.open(token, nickname);
        var response = ResponseEntity.ok().cacheControl(CacheControl.noStore());
        if (issued.token() == null) return response.body(issued.session());
        var remaining = Duration.between(Instant.now(), issued.session().expiresAt());
        long maxAge = remaining.isNegative() ? 0 : remaining.plusNanos(999_999_999).toSeconds();
        var cookie = ResponseCookie.from(SESSION, issued.token()).httpOnly(true).sameSite("Lax").path("/")
                .secure(origin.startsWith("https://")).maxAge(maxAge).build();
        return response.header(HttpHeaders.SET_COOKIE, cookie.toString()).body(issued.session());
    }

    @GetMapping("/api/me")
    ResponseEntity<SessionService.Session> me(@CookieValue(value = SESSION, required = false) String cookie) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(sessions.require(cookie));
    }

    @PostMapping("/api/sessions/logout")
    ResponseEntity<Void> logout(@RequestHeader(value = "Origin", required = false) String from,
                               @CookieValue(value = SESSION, required = false) String token) {
        checkOrigin(from);
        sessions.logout(token);
        var cookie = ResponseCookie.from(SESSION, "").httpOnly(true).sameSite("Lax").path("/")
                .secure(origin.startsWith("https://")).maxAge(0).build();
        return ResponseEntity.noContent().cacheControl(CacheControl.noStore())
                .header(HttpHeaders.SET_COOKIE, cookie.toString()).build();
    }

    @PostMapping("/api/rooms")
    ResponseEntity<RoomService.CreateResult> create(@RequestHeader(value = "Origin", required = false) String from,
                                                    @CookieValue(value = SESSION, required = false) String cookie,
                                                    @Valid @RequestBody CreateRequest request) {
        String actor = actor(from, cookie);
        int seconds = request.durationSeconds() == null ? 30 : request.durationSeconds();
        if (!Set.of(30, 60, 120, 300).contains(seconds)) throw invalid();
        String style = request.retellStyle() == null ? "auditory" : request.retellStyle();
        String topic = request.topic() == null ? "家庭日常" : request.topic().strip();
        if (topic.isEmpty()) throw invalid();
        var teen = request.teen();
        if ("teen".equals(request.mode()) != (teen != null)) throw invalid();
        String nickname = teen == null ? null : teen.nickname() == null || teen.nickname().isBlank() ? "孩子" : teen.nickname().strip();
        var data = rooms.create(actor, request.createKey(), request.mode(), seconds, style, topic,
                nickname, teen == null ? null : teen.role());
        return ResponseEntity.status(data.created() ? 201 : 200).body(data);
    }

    @GetMapping("/api/rooms/{roomId}")
    ResponseEntity<RoomService.State> snapshot(@PathVariable UUID roomId,
                                              @CookieValue(value = SESSION, required = false) String cookie) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
                .body(rooms.snapshot(roomId.toString(), sessions.require(cookie).id()));
    }

    @GetMapping("/api/rooms/async-messages")
    ResponseEntity<List<RoomMapper.AsyncMessage>> asyncMessages(@CookieValue(value = SESSION, required = false) String cookie) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(rooms.asyncMessages(sessions.require(cookie).id()));
    }

    @PostMapping("/api/rooms/{roomId}/invitations")
    ResponseEntity<RoomService.PublicInvite> invite(@PathVariable UUID roomId,
                                                   @RequestHeader(value = "Origin", required = false) String from,
                                                   @CookieValue(value = SESSION, required = false) String cookie,
                                                   @Valid @RequestBody InviteRequest request) {
        return ResponseEntity.status(201).body(rooms.invite(roomId.toString(), actor(from, cookie),
                request.role(), request.minutes(), request.maxUses(), request.password()));
    }

    @PostMapping("/api/rooms/join")
    RoomService.State join(@RequestHeader(value = "Origin", required = false) String from,
                           @CookieValue(value = SESSION, required = false) String cookie,
                           @Valid @RequestBody JoinRequest request) {
        return rooms.join(actor(from, cookie), request.token(), request.password());
    }

    @PostMapping("/api/rooms/{roomId}/ready")
    RoomService.State ready(@PathVariable UUID roomId,
                            @RequestHeader(value = "Origin", required = false) String from,
                            @CookieValue(value = SESSION, required = false) String cookie,
                            @Valid @RequestBody ReadyRequest request) {
        return rooms.ready(roomId.toString(), actor(from, cookie), request.ready());
    }

    @PostMapping("/api/rooms/{roomId}/start")
    RoomService.State start(@PathVariable UUID roomId,
                            @RequestHeader(value = "Origin", required = false) String from,
                            @CookieValue(value = SESSION, required = false) String cookie) {
        return rooms.start(roomId.toString(), actor(from, cookie));
    }

    @PostMapping("/api/rooms/{roomId}/next-round")
    RoomService.State nextRound(@PathVariable UUID roomId,
                                @RequestHeader(value = "Origin", required = false) String from,
                                @CookieValue(value = SESSION, required = false) String cookie,
                                @Valid @RequestBody NextRoundRequest request) {
        return rooms.prepareNext(roomId.toString(), actor(from, cookie), request.roundId().toString(), request.expectedVersion());
    }

    @PostMapping("/api/rooms/{roomId}/swap-seats")
    RoomService.State swapSeats(@PathVariable UUID roomId,
                                @RequestHeader(value = "Origin", required = false) String from,
                                @CookieValue(value = SESSION, required = false) String cookie,
                                @Valid @RequestBody VersionRequest request) {
        return rooms.swapSeats(roomId.toString(), actor(from, cookie), request.expectedVersion());
    }

    @PostMapping("/api/rounds/{roundId}/task")
    RoomService.RecordingState beginRecording(@PathVariable UUID roundId,
                                               @RequestHeader(value = "Origin", required = false) String from,
                                               @CookieValue(value = SESSION, required = false) String cookie,
                                               @Valid @RequestBody TaskRequest request) {
        return rooms.beginRecording(roundId.toString(), actor(from, cookie), request.expectedVersion(),
                request.focus() == null ? "" : request.focus().strip());
    }

    @PostMapping("/api/rounds/{roundId}/restart-recording")
    RoomService.RecordingState restartRecording(@PathVariable UUID roundId,
                                                 @RequestHeader(value = "Origin", required = false) String from,
                                                 @CookieValue(value = SESSION, required = false) String cookie,
                                                 @Valid @RequestBody RestartRequest request) {
        return rooms.restartRecording(roundId.toString(), actor(from, cookie), request.expectedVersion(), request.kind());
    }

    @PostMapping("/api/rounds/{roundId}/open-message")
    RoomService.RecordingState openMessage(@PathVariable UUID roundId,
                                          @RequestHeader(value = "Origin", required = false) String from,
                                          @CookieValue(value = SESSION, required = false) String cookie,
                                          @Valid @RequestBody VersionRequest request) {
        return rooms.openMessage(roundId.toString(), actor(from, cookie), request.expectedVersion());
    }

    @PostMapping("/api/rooms/{roomId}/leave")
    Map<String, String> leave(@PathVariable UUID roomId,
                              @RequestHeader(value = "Origin", required = false) String from,
                              @CookieValue(value = SESSION, required = false) String cookie) {
        return Map.of("status", rooms.leave(roomId.toString(), actor(from, cookie)));
    }

    private String actor(String from, String cookie) {
        checkOrigin(from);
        return sessions.require(cookie).id();
    }

    private void checkOrigin(String from) {
        if (!origin.equals(from)) throw new ApiFailure(403, "ORIGIN_DENIED");
    }
}
