package io.snailecho;

import java.util.List;
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
class ComparisonController {
    private static final String SESSION = "echo_session";
    private static final String TAG = "遗漏重要信息|理解不到位|理解偏了|杜撰信息|强加信息|我表达不清|我言不达意|语气被误解|重点被误解|AI 误判";
    private static final String RESOLUTION = "misunderstanding|expression|ai_error";
    private final ComparisonService service;
    private final SessionService sessions;
    private final String origin;

    ComparisonController(ComparisonService service, SessionService sessions, @Value("${echo.origin}") String origin) {
        this.service = service;
        this.sessions = sessions;
        this.origin = origin;
    }

    record Version(@NotNull @Min(1) Long expectedVersion) {}
    record WholeLabels(@NotNull @Min(1) Long expectedVersion, @NotNull @Size(max = 6) List<String> retellTags,
                       @NotNull @Size(max = 3) List<String> expressionTags) {}
    record WholeNote(@NotNull @Min(1) Long expectedVersion, @NotNull @Size(max = 500) String note) {}
    record Issue(@NotNull @Min(1) Long expectedVersion, @NotNull UUID issueId) {}
    record Note(@NotNull @Min(1) Long expectedVersion, @NotNull UUID issueId, @NotBlank @Size(max = 500) String note) {}
    record Observation(@NotNull @Min(1) Long expectedVersion, @NotNull UUID issueId,
                       @NotNull @Pattern(regexp = TAG) String tag, @NotNull @Size(max = 500) String note) {}
    record Label(@NotNull UUID issueId, @NotNull @Pattern(regexp = TAG) String tag,
                 @NotNull @Pattern(regexp = RESOLUTION) String resolution) {
        ComparisonService.Label value() { return new ComparisonService.Label(issueId.toString(), tag, resolution); }
    }
    record Labels(@NotNull @Min(1) Long expectedVersion, @NotNull @Size(max = 12) List<@NotNull @Valid Label> labels) {}
    record Revision(@NotNull @Min(1) Long expectedVersion, @NotNull UUID issueId,
                    @NotNull @Pattern(regexp = TAG) String tag, @NotNull @Pattern(regexp = RESOLUTION) String resolution) {}

    @GetMapping("/comparison")
    ResponseEntity<ComparisonService.View> view(@PathVariable UUID roundId,
            @CookieValue(value = SESSION, required = false) String cookie) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
                .body(service.view(roundId.toString(), sessions.require(cookie).id()));
    }

    @PostMapping("/review/label")
    ComparisonService.Updated label(@PathVariable UUID roundId, @Valid @RequestBody Labels command,
            @RequestHeader(value = "Origin", required = false) String from,
            @CookieValue(value = SESSION, required = false) String cookie) {
        return service.label(roundId.toString(), actor(from, cookie), command.expectedVersion(),
                command.labels().stream().map(Label::value).toList());
    }

    @PostMapping("/review/round-labels")
    ComparisonService.Updated wholeLabels(@PathVariable UUID roundId, @Valid @RequestBody WholeLabels command,
            @RequestHeader(value = "Origin", required = false) String from,
            @CookieValue(value = SESSION, required = false) String cookie) {
        return service.labelWholeRound(roundId.toString(), actor(from, cookie), command.expectedVersion(),
                command.retellTags(), command.expressionTags());
    }

    @PostMapping("/review/round-clarification")
    ComparisonService.Updated wholeClarification(@PathVariable UUID roundId, @Valid @RequestBody WholeNote command,
            @RequestHeader(value = "Origin", required = false) String from,
            @CookieValue(value = SESSION, required = false) String cookie) {
        return service.clarifyWholeRound(roundId.toString(), actor(from, cookie), command.expectedVersion(), command.note());
    }

    @PostMapping("/review/open-round-review")
    ComparisonService.Updated openRoundReview(@PathVariable UUID roundId, @Valid @RequestBody Version command,
            @RequestHeader(value = "Origin", required = false) String from,
            @CookieValue(value = SESSION, required = false) String cookie) {
        return service.openWholeRoundReview(roundId.toString(), actor(from, cookie), command.expectedVersion());
    }

    @PostMapping("/review/revise")
    ComparisonService.Updated revise(@PathVariable UUID roundId, @Valid @RequestBody Revision command,
            @RequestHeader(value = "Origin", required = false) String from,
            @CookieValue(value = SESSION, required = false) String cookie) {
        var label = new ComparisonService.Label(command.issueId().toString(), command.tag(), command.resolution());
        return service.revise(roundId.toString(), actor(from, cookie), command.expectedVersion(), label);
    }

    @PostMapping("/review/clarify")
    ComparisonService.Updated clarify(@PathVariable UUID roundId, @Valid @RequestBody Note command,
            @RequestHeader(value = "Origin", required = false) String from,
            @CookieValue(value = SESSION, required = false) String cookie) {
        return service.clarify(roundId.toString(), actor(from, cookie), command.expectedVersion(),
                command.issueId().toString(), command.note().strip());
    }

    @PostMapping("/review/observe")
    ComparisonService.Updated observe(@PathVariable UUID roundId, @Valid @RequestBody Observation command,
            @RequestHeader(value = "Origin", required = false) String from,
            @CookieValue(value = SESSION, required = false) String cookie) {
        return service.observe(roundId.toString(), actor(from, cookie), command.expectedVersion(),
                command.issueId().toString(), command.tag(), command.note().strip());
    }

    @PostMapping("/review/confirm")
    ComparisonService.Updated confirm(@PathVariable UUID roundId, @Valid @RequestBody Issue command,
            @RequestHeader(value = "Origin", required = false) String from,
            @CookieValue(value = SESSION, required = false) String cookie) {
        return service.confirm(roundId.toString(), actor(from, cookie), command.expectedVersion(), command.issueId().toString());
    }

    @PostMapping("/review/submit")
    ComparisonService.Updated submit(@PathVariable UUID roundId, @Valid @RequestBody Version command,
            @RequestHeader(value = "Origin", required = false) String from,
            @CookieValue(value = SESSION, required = false) String cookie) {
        return service.submit(roundId.toString(), actor(from, cookie), command.expectedVersion());
    }

    @PostMapping("/review/adopt")
    ComparisonService.Updated adopt(@PathVariable UUID roundId, @Valid @RequestBody Version command,
            @RequestHeader(value = "Origin", required = false) String from,
            @CookieValue(value = SESSION, required = false) String cookie) {
        return service.adopt(roundId.toString(), actor(from, cookie), command.expectedVersion());
    }

    private String actor(String from, String cookie) {
        if (!origin.equals(from)) throw new ApiFailure(403, "ORIGIN_DENIED");
        return sessions.require(cookie).id();
    }
}
