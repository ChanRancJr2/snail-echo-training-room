package io.snailecho;

import java.util.List;
import java.util.UUID;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.CacheControl;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.CookieValue;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

@RestController
@RequestMapping("/api/practice/analysis/{id}")
@ConditionalOnProperty(name = "echo.processing.enabled", havingValue = "true")
class SoloPracticeAnalysisController {
    private final SoloPracticeAnalysis analysis;
    private final SessionService sessions;
    private final String origin;

    SoloPracticeAnalysisController(SoloPracticeAnalysis analysis, SessionService sessions, @Value("${echo.origin}") String origin) {
        this.analysis = analysis;
        this.sessions = sessions;
        this.origin = origin;
    }

    record Report(@NotNull Boolean accepted) {}
    record Review(@NotNull @Size(max = 12) List<SoloPracticeAnalysis.ReviewChoice> choices) {}
    record WholeReview(@NotNull @Size(max = 6) List<String> retellTags,
                       @NotNull @Size(max = 3) List<String> expressionTags, @Size(max = 500) String note) {}

    @PostMapping(value = "/audio", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    ResponseEntity<Void> audio(@PathVariable UUID id, @RequestParam String materialId,
            @RequestParam int duration, @RequestParam boolean consent, @RequestParam MultipartFile recording,
            @RequestHeader(value = "Origin", required = false) String from,
            @CookieValue(value = "echo_session", required = false) String cookie) {
        String owner = actor(from, cookie);
        if (!consent) throw new ApiFailure(400, "CONSENT_REQUIRED");
        analysis.submitAudio(id.toString(), owner, materialId, duration, recording);
        return ResponseEntity.accepted().cacheControl(CacheControl.noStore()).build();
    }

    @GetMapping
    ResponseEntity<SoloPracticeAnalysis.View> view(@PathVariable UUID id,
            @CookieValue(value = "echo_session", required = false) String cookie) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(analysis.view(id.toString(), sessions.require(cookie).id()));
    }

    @PostMapping("/advice")
    ResponseEntity<CoachingAdvice.View> submitReview(@PathVariable UUID id, @Valid @RequestBody Review review,
            @RequestHeader(value = "Origin", required = false) String from,
            @CookieValue(value = "echo_session", required = false) String cookie) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
                .body(analysis.submitReview(id.toString(), actor(from, cookie), review.choices()));
    }

    @GetMapping("/advice")
    ResponseEntity<CoachingAdvice.View> advice(@PathVariable UUID id,
            @CookieValue(value = "echo_session", required = false) String cookie) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(analysis.advice(id.toString(), sessions.require(cookie).id()));
    }

    @PostMapping("/round-feedback")
    ResponseEntity<CoachingAdvice.View> submitWholeReview(@PathVariable UUID id, @Valid @RequestBody WholeReview review,
            @RequestHeader(value = "Origin", required = false) String from,
            @CookieValue(value = "echo_session", required = false) String cookie) {
        String owner = actor(from, cookie);
        var feedback = WholeRoundFeedback.create(review.retellTags(), review.expressionTags(), review.note());
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
                .body(analysis.submitWholeReview(id.toString(), owner, feedback));
    }

    @PostMapping("/archive")
    ResponseEntity<Void> archive(@PathVariable UUID id, @Valid @RequestBody Report report,
            @RequestHeader(value = "Origin", required = false) String from,
            @CookieValue(value = "echo_session", required = false) String cookie) {
        analysis.archive(id.toString(), actor(from, cookie), report.accepted());
        return ResponseEntity.noContent().cacheControl(CacheControl.noStore()).build();
    }

    private String actor(String from, String cookie) {
        if (!origin.equals(from)) throw new ApiFailure(403, "ORIGIN_DENIED");
        return sessions.require(cookie).id();
    }
}
