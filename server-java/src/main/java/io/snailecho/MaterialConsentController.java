package io.snailecho;

import java.util.UUID;
import java.util.regex.Pattern;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.CacheControl;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.CookieValue;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestPart;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

@RestController
@ConditionalOnProperty(name = "echo.storage.enabled", havingValue = "true")
class MaterialConsentController {
    private static final String SESSION = "echo_session";
    private static final String ROOM = "/api/rounds/{roundId}/audio/{audioId}/material-consent";
    private static final String PRACTICE = "/api/practice/reports/{reportId}/material-consent";
    private static final Pattern REPORT_ID = Pattern.compile(
            "[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}");
    private final MaterialConsentService materials;
    private final SessionService sessions;
    private final String origin;

    MaterialConsentController(MaterialConsentService materials, SessionService sessions,
                              @Value("${echo.origin}") String origin) {
        this.materials = materials;
        this.sessions = sessions;
        this.origin = origin;
    }

    record Status(boolean submitted) {}

    @GetMapping(ROOM)
    ResponseEntity<Status> roomStatus(@PathVariable UUID roundId, @PathVariable UUID audioId,
                                      @CookieValue(value = SESSION, required = false) String cookie) {
        return response(materials.roomStatus(roundId.toString(), audioId.toString(), sessions.require(cookie).id()));
    }

    @PostMapping(ROOM)
    ResponseEntity<Status> submitRoom(@PathVariable UUID roundId, @PathVariable UUID audioId,
                                      @RequestHeader(value = "Origin", required = false) String from,
                                      @CookieValue(value = SESSION, required = false) String cookie) {
        return response(materials.submitRoom(roundId.toString(), audioId.toString(), actor(from, cookie)));
    }

    @GetMapping(PRACTICE)
    ResponseEntity<Status> practiceStatus(@PathVariable String reportId,
                                          @CookieValue(value = SESSION, required = false) String cookie) {
        return response(materials.practiceStatus(validReportId(reportId), sessions.require(cookie).id()));
    }

    @PostMapping(path = PRACTICE, consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    ResponseEntity<Status> submitPractice(@PathVariable String reportId, @RequestPart("audio") MultipartFile audio,
                                          @RequestHeader(value = "Origin", required = false) String from,
                                          @CookieValue(value = SESSION, required = false) String cookie) {
        return response(materials.submitPractice(validReportId(reportId), actor(from, cookie), audio));
    }

    private String actor(String from, String cookie) {
        if (!origin.equals(from)) throw new ApiFailure(403, "ORIGIN_DENIED");
        return sessions.require(cookie).id();
    }

    private static String validReportId(String id) {
        if (!REPORT_ID.matcher(id).matches()) throw ApiFailure.invalid();
        return id;
    }

    private static ResponseEntity<Status> response(boolean submitted) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(new Status(submitted));
    }
}
