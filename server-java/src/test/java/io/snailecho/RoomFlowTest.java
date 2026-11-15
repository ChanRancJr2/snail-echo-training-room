package io.snailecho;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.containers.MySQLContainer;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Executors;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = "echo.round-sweep-delay-ms=3600000")
class RoomFlowTest {
    private static final String ORIGIN = "http://localhost:3100";
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final HttpClient HTTP = HttpClient.newHttpClient();
    private static final MySQLContainer<?> DATABASE = new MySQLContainer<>("mysql:8.4");
    @LocalServerPort int port;
    @Autowired JdbcTemplate database;
    @Autowired RoundExpiry expiry;

    @BeforeAll static void database() { DATABASE.start(); }

    @DynamicPropertySource static void settings(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", DATABASE::getJdbcUrl);
        registry.add("spring.datasource.username", DATABASE::getUsername);
        registry.add("spring.datasource.password", DATABASE::getPassword);
    }

    @Test void onlyOneRoundStartsAfterBothParticipantsAreReady() throws Exception {
        String host = session();
        String guest = session();
        var created = post("/api/rooms", Map.of("mode", "sync", "createKey", UUID.randomUUID()), host);
        assertThat(created.statusCode()).isEqualTo(201);
        var data = body(created);
        String room = "/api/rooms/" + data.at("/state/id").asText();
        assertThat(post(room + "/start", Map.of(), host).statusCode()).isEqualTo(409);
        var join = post("/api/rooms/join", Map.of("token", data.get("inviteToken").asText()), guest);
        assertThat(body(join).at("/you/role").asText()).isEqualTo("listener");
        assertThat(post(room + "/ready", Map.of("ready", true), host).statusCode()).isEqualTo(200);
        assertThat(post(room + "/start", Map.of(), host).statusCode()).isEqualTo(409);
        assertThat(post(room + "/ready", Map.of("ready", true), guest).statusCode()).isEqualTo(200);
        assertThat(post(room + "/start", Map.of(), guest).statusCode()).isEqualTo(403);
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            var a = executor.submit(() -> post(room + "/start", Map.of(), host));
            var b = executor.submit(() -> post(room + "/start", Map.of(), host));
            var first = a.get();
            var second = b.get();
            assertThat(first.statusCode()).isEqualTo(200);
            assertThat(second.statusCode()).isEqualTo(200);
            var state = body(first);
            assertThat(state.get("roundId").asText()).isNotBlank();
            assertThat(body(second).get("roundId")).isEqualTo(state.get("roundId"));
            assertThat(state.get("stage").asText()).isEqualTo("TASK");
            assertThat(state.get("deadlineAt").isNull()).isTrue();
            assertThat(database.queryForObject("SELECT COUNT(*) FROM rounds WHERE room_id = ?", Integer.class,
                    data.at("/state/id").asText())).isEqualTo(1);
        }
    }

    @Test void expiredInvitesAndUnrelatedSessionsCannotMutateTheRoom() throws Exception {
        String host = session();
        String guest = session();
        var created = body(post("/api/rooms", Map.of("mode", "sync", "createKey", UUID.randomUUID()), host));
        String id = created.at("/state/id").asText();
        String room = "/api/rooms/" + id;
        assertThat(post(room + "/ready", Map.of("ready", true), guest).statusCode()).isEqualTo(403);
        assertThat(post(room + "/ready", Map.of("ready", true), "").statusCode()).isEqualTo(401);
        var foreign = HttpRequest.newBuilder(URI.create("http://localhost:" + port + room + "/ready"))
                .timeout(Duration.ofSeconds(10)).header("Origin", "https://example.invalid")
                .header("Cookie", host).header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString("{\"ready\":true}")).build();
        assertThat(HTTP.send(foreign, HttpResponse.BodyHandlers.ofString()).statusCode()).isEqualTo(403);
        database.update("UPDATE invitations SET expires_at = CURRENT_TIMESTAMP(6) WHERE room_id = ?", id);
        assertThat(post("/api/rooms/join", Map.of("token", created.get("inviteToken").asText()), guest).statusCode()).isEqualTo(410);
    }

    @Test void invitationIsRoleBoundAndAClosedRoomCannotBeRejoined() throws Exception {
        String host = session();
        String observer = session();
        String outsider = session();
        var request = Map.of("mode", "sync", "createKey", UUID.randomUUID());
        var created = body(post("/api/rooms", request, host));
        String room = "/api/rooms/" + created.at("/state/id").asText();
        assertThat(body(post("/api/rooms", request, host)).at("/state/id")).isEqualTo(created.at("/state/id"));
        var invitation = post(room + "/invitations",
                Map.of("role", "observer", "minutes", 60, "maxUses", 1, "password", "test-password"), host);
        assertThat(invitation.statusCode()).isEqualTo(201);
        String token = body(invitation).get("token").asText();
        assertThat(post("/api/rooms/join", Map.of("token", token), observer).statusCode()).isEqualTo(403);
        var join = post("/api/rooms/join", Map.of("token", token, "password", "test-password"), observer);
        assertThat(body(join).at("/you/role").asText()).isEqualTo("observer");
        assertThat(post("/api/rooms/join", Map.of("token", token), observer).statusCode()).isEqualTo(200);
        assertThat(post("/api/rooms/join", Map.of("token", token, "password", "test-password"), outsider).statusCode()).isEqualTo(410);
        assertThat(post(room + "/ready", Map.of("ready", true), observer).statusCode()).isEqualTo(200);
        assertThat(post(room + "/leave", Map.of(), host).statusCode()).isEqualTo(200);
        assertThat(post("/api/rooms/join", Map.of("token", created.get("inviteToken").asText()), outsider).statusCode()).isEqualTo(410);
    }

    @Test void openingTheAppAgainPreservesTheCurrentSession() throws Exception {
        var first = post("/api/sessions/anonymous", Map.of(), "");
        String cookie = first.headers().firstValue("set-cookie").orElseThrow().split(";", 2)[0];
        var reopened = post("/api/sessions/anonymous", Map.of(), cookie);
        assertThat(reopened.statusCode()).isEqualTo(200);
        assertThat(body(reopened)).isEqualTo(body(first));
        assertThat(reopened.headers().firstValue("set-cookie")).isEmpty();
    }

    @Test void concurrentClaimsOfOneInviteDoNotConsumeItTwice() throws Exception {
        String host = session();
        String guestA = session();
        String guestB = session();
        var request = Map.of("mode", "sync", "createKey", UUID.randomUUID());
        var created = body(post("/api/rooms", request, host));
        var retried = body(post("/api/rooms", request, host));
        String id = created.at("/state/id").asText();
        assertThat(retried.at("/state/id").asText()).isEqualTo(id);
        var invite = post("/api/rooms/" + id + "/invitations",
                Map.of("role", "listener", "minutes", 60, "maxUses", 1), host);
        assertThat(invite.statusCode()).isEqualTo(201);
        var join = Map.of("token", body(invite).get("token").asText());
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            var a = executor.submit(() -> post("/api/rooms/join", join, guestA));
            var b = executor.submit(() -> post("/api/rooms/join", join, guestB));
            assertThat(new Integer[]{a.get().statusCode(), b.get().statusCode()}).containsExactlyInAnyOrder(200, 410);
        }
        assertThat(database.queryForObject("SELECT COUNT(*) FROM room_members WHERE room_id = ? AND role = 'listener'",
                Integer.class, id)).isEqualTo(1);
    }

    @Test void anotherRoundInTheSameRoomResetsReadinessAndRecordingClock() throws Exception {
        String host = session();
        String guest = session();
        var created = body(post("/api/rooms", Map.of("mode", "sync", "createKey", UUID.randomUUID()), host));
        String room = "/api/rooms/" + created.at("/state/id").asText();
        assertThat(post("/api/rooms/join", Map.of("token", created.get("inviteToken").asText()), guest).statusCode()).isEqualTo(200);
        post(room + "/ready", Map.of("ready", true), host);
        post(room + "/ready", Map.of("ready", true), guest);
        var first = body(post(room + "/start", Map.of(), host));
        String round = first.get("roundId").asText();
        String task = "/api/rounds/" + round + "/task";
        var command = Map.of("expectedVersion", first.get("roundVersion").asLong(), "focus", "关键条件");
        assertThat(post(task, command, guest).statusCode()).isEqualTo(403);
        Instant before = Instant.now();
        var recording = post(task, command, host);
        assertThat(recording.statusCode()).isEqualTo(200);
        var recordingState = body(recording);
        assertThat(recordingState.get("stage").asText()).isEqualTo("SPEAKER_RECORDING");
        assertThat(Instant.parse(recordingState.get("deadlineAt").asText())).isBetween(before.plusSeconds(29), Instant.now().plusSeconds(31));
        assertThat(post(task, command, host).statusCode()).isEqualTo(409);

        // Media and review are separate slices. Simulate arrival at the final advice step.
        database.update("UPDATE rounds SET stage = 'ADVICE', deadline_at = NULL, version = version + 1 WHERE id = ?", round);
        var nextCommand = Map.of("roundId", round, "expectedVersion", recordingState.get("version").asLong() + 1);
        var prepared = post(room + "/next-round", nextCommand, host);
        assertThat(prepared.statusCode()).isEqualTo(200);
        assertThat(body(prepared).get("status").asText()).isEqualTo("WAITING");
        assertThat(body(prepared).at("/you/ready").asBoolean()).isFalse();
        assertThat(post(room + "/start", Map.of(), host).statusCode()).isEqualTo(409);
        assertThat(post(room + "/next-round", nextCommand, host).statusCode()).isEqualTo(200);
        var swap = Map.of("expectedVersion", body(prepared).get("version").asLong());
        assertThat(post(room + "/swap-seats", swap, guest).statusCode()).isEqualTo(403);
        var swapped = post(room + "/swap-seats", swap, host);
        assertThat(swapped.statusCode()).isEqualTo(200);
        assertThat(body(swapped).at("/you/role").asText()).isEqualTo("listener");
        assertThat(body(swapped).at("/you/owner").asBoolean()).isTrue();
        assertThat(post(room + "/swap-seats", swap, host).statusCode()).isEqualTo(409);
        post(room + "/ready", Map.of("ready", true), host);
        post(room + "/ready", Map.of("ready", true), guest);
        assertThat(post(room + "/start", Map.of(), host).statusCode()).isEqualTo(403);
        var second = body(post(room + "/start", Map.of(), guest));
        assertThat(second.get("roundId").asText()).isNotBlank().isNotEqualTo(round);
        assertThat(second.get("deadlineAt").isNull()).isTrue();
        assertThat(post(room + "/next-round", nextCommand, guest).statusCode()).isEqualTo(409);
        assertThat(post(task, command, host).statusCode()).isEqualTo(409);
        assertThat(post(room + "/leave", Map.of(), host).statusCode()).isEqualTo(200);
        assertThat(database.queryForObject("SELECT stage FROM rounds WHERE id = ?", String.class,
                second.get("roundId").asText())).isEqualTo("CANCELLED");
    }

    @Test void recordingMayBeRestartedAndTheSweeperRespectsTheUploadGracePeriod() throws Exception {
        String host = session();
        String guest = session();
        var created = body(post("/api/rooms", Map.of("mode", "sync", "createKey", UUID.randomUUID()), host));
        String id = created.at("/state/id").asText();
        String room = "/api/rooms/" + id;
        assertThat(post("/api/rooms/join", Map.of("token", created.get("inviteToken").asText()), guest).statusCode()).isEqualTo(200);
        post(room + "/ready", Map.of("ready", true), host);
        post(room + "/ready", Map.of("ready", true), guest);
        var started = body(post(room + "/start", Map.of(), host));
        String round = started.get("roundId").asText();
        String path = "/api/rounds/" + round;
        var recorded = body(post(path + "/task", Map.of("expectedVersion", 1, "focus", "重点"), host));
        long version = recorded.get("version").asLong();
        database.update("UPDATE rounds SET deadline_at = TIMESTAMPADD(SECOND, -10, CURRENT_TIMESTAMP(6)) WHERE id = ?", round);
        expiry.sweep();
        assertThat(database.queryForObject("SELECT stage FROM rounds WHERE id = ?", String.class, round)).isEqualTo("SPEAKER_RECORDING");
        var command = Map.of("expectedVersion", version, "kind", "speaker");
        assertThat(post(path + "/restart-recording", command, guest).statusCode()).isEqualTo(403);
        var restart = post(path + "/restart-recording", command, host);
        assertThat(restart.statusCode()).isEqualTo(200);
        var restarted = body(restart);
        assertThat(restarted.get("version").asLong()).isEqualTo(version + 1);
        assertThat(Instant.parse(restarted.get("deadlineAt").asText())).isAfter(Instant.now().plusSeconds(25));
        assertThat(post(path + "/restart-recording", command, host).statusCode()).isEqualTo(409);
        assertThat(database.queryForObject("SELECT focus FROM rounds WHERE id = ?", String.class, round)).isEqualTo("重点");

        database.update("UPDATE rounds SET deadline_at = TIMESTAMPADD(SECOND, -40, CURRENT_TIMESTAMP(6)) WHERE id = ?", round);
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            var a = executor.submit(expiry::sweep);
            var b = executor.submit(expiry::sweep);
            a.get();
            b.get();
        }
        assertThat(database.queryForObject("SELECT stage FROM rounds WHERE id = ?", String.class, round)).isEqualTo("CANCELLED");
        assertThat(database.queryForObject("SELECT version FROM rounds WHERE id = ?", Long.class, round)).isEqualTo(version + 2);
        assertThat(database.queryForObject("SELECT status FROM rooms WHERE id = ?", String.class, id)).isEqualTo("WAITING");
        assertThat(post(room + "/start", Map.of(), host).statusCode()).isEqualTo(409);
    }

    private String session() throws Exception {
        var response = post("/api/sessions/anonymous", Map.of(), "");
        assertThat(response.statusCode()).isEqualTo(200);
        return response.headers().firstValue("set-cookie").orElseThrow().split(";", 2)[0];
    }

    private HttpResponse<String> post(String path, Map<String, ?> payload, String cookie) throws Exception {
        var request = HttpRequest.newBuilder(URI.create("http://localhost:" + port + path))
                .timeout(Duration.ofSeconds(10)).header("Origin", ORIGIN).header("Cookie", cookie)
                .header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString(JSON.writeValueAsString(payload)));
        return HTTP.send(request.build(), HttpResponse.BodyHandlers.ofString());
    }

    private JsonNode body(HttpResponse<String> response) throws Exception { return JSON.readTree(response.body()); }
}
