package io.snailecho;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.containers.MySQLContainer;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.wait.strategy.Wait;
import org.testcontainers.lifecycle.Startables;
import org.testcontainers.utility.DockerImageName;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = "echo.round-sweep-delay-ms=3600000")
class RoomFlowTest {
    private static final String ORIGIN = "http://localhost:3100";
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final HttpClient HTTP = HttpClient.newHttpClient();
    private static final MySQLContainer<?> DATABASE = new MySQLContainer<>("mysql:8.4");
    private static final GenericContainer<?> STORAGE = new GenericContainer<>(DockerImageName.parse(
            "chrislusf/seaweedfs@sha256:c2658820e763294a9e9de7b36c81e59b879e3459148351aee4e31a126ca64860"))
            .withCommand("mini", "-dir=/data")
            .withEnv("AWS_ACCESS_KEY_ID", "dev_echo_access")
            .withEnv("AWS_SECRET_ACCESS_KEY", "dev_echo_secret_only")
            .withEnv("S3_BUCKET", "echo-private")
            .withExposedPorts(8333)
            .waitingFor(Wait.forListeningPort());
    @LocalServerPort int port;
    @Autowired JdbcTemplate database;
    @Autowired RoundExpiry expiry;
    @Autowired TranscriptionWorker worker;
    @Autowired TranscriptionQueue queue;
    @Autowired TranscriptionMapper transcriptionJobs;
    @Autowired S3AudioStorage objectStorage;
    @Autowired AsrArtifactCleanup cleanup;

    @BeforeAll static void dependencies() { Startables.deepStart(DATABASE, STORAGE).join(); }

    @DynamicPropertySource static void settings(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", DATABASE::getJdbcUrl);
        registry.add("spring.datasource.username", DATABASE::getUsername);
        registry.add("spring.datasource.password", DATABASE::getPassword);
        registry.add("echo.storage.enabled", () -> true);
        registry.add("echo.storage.endpoint", () -> "http://" + STORAGE.getHost() + ":" + STORAGE.getMappedPort(8333));
        registry.add("echo.storage.bucket", () -> "echo-private");
        registry.add("echo.storage.access-key", () -> "dev_echo_access");
        registry.add("echo.storage.secret-key", () -> "dev_echo_secret_only");
        registry.add("echo.processing.enabled", () -> true);
        registry.add("echo.processing.mode", () -> "mock");
        registry.add("echo.processing.master-key", () -> java.util.Base64.getEncoder().encodeToString(new byte[32]));
        registry.add("echo.processing.worker-delay-ms", () -> 3600000);
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

    @Test void signedUploadSurvivesRetriesAndStagingOverwrite() throws Exception {
        var fixture = recordingRoom();
        byte[] original = sampleWave((short) 100);
        byte[] replacement = sampleWave((short) 200);
        String route = fixture.path() + "/uploads";
        String key = UUID.randomUUID().toString();
        var request = Map.of("kind", "speaker", "mimeType", "audio/wav", "byteSize", original.length, "idempotencyKey", key);
        assertThat(post(route, request, fixture.listener()).statusCode()).isEqualTo(403);
        var response = post(route, request, fixture.speaker());
        assertThat(response.statusCode()).isEqualTo(200);
        var requested = body(response);
        String id = requested.get("audioId").asText();
        assertThat(body(post(route, request, fixture.speaker())).get("audioId").asText()).isEqualTo(id);
        assertThat(post(route, Map.of("kind", "speaker", "mimeType", "audio/wav", "byteSize", original.length + 1,
                "idempotencyKey", key), fixture.speaker()).statusCode()).isEqualTo(409);
        String putUrl = requested.get("uploadUrl").asText();
        String confirm = route + "/" + id + "/commit";
        var commit = Map.of("expectedVersion", fixture.version(), "transcribe", true);
        assertThat(post(confirm, commit, fixture.listener()).statusCode()).isEqualTo(403);
        assertThat(post(confirm, commit, fixture.speaker()).statusCode()).isEqualTo(409);
        assertThat(putAudio(putUrl, "audio/wav", new byte[original.length])).isBetween(200, 299);
        var badAudio = post(confirm, commit, fixture.speaker());
        assertThat(badAudio.statusCode()).isEqualTo(400);
        assertThat(body(badAudio).get("error").asText()).isEqualTo("UNSUPPORTED_AUDIO");
        assertThat(putAudio(putUrl, "audio/wav", original)).isBetween(200, 299);
        var second = body(post(route, Map.of("kind", "speaker", "mimeType", "audio/wav", "byteSize", original.length,
                "idempotencyKey", UUID.randomUUID()), fixture.speaker()));
        String secondId = second.get("audioId").asText();
        assertThat(putAudio(second.get("uploadUrl").asText(), "audio/wav", original)).isBetween(200, 299);

        String winner;
        try (var threads = Executors.newVirtualThreadPerTaskExecutor()) {
            var first = threads.submit(() -> post(confirm, commit, fixture.speaker()));
            var other = threads.submit(() -> post(route + "/" + secondId + "/commit", commit, fixture.speaker()));
            assertThat(first.get().statusCode()).isEqualTo(200);
            assertThat(other.get().statusCode()).isEqualTo(200);
            winner = body(first.get()).get("audioId").asText();
            assertThat(body(other.get()).get("audioId").asText()).isEqualTo(winner);
            assertThat(body(first.get()).at("/round/stage").asText()).isEqualTo("KEYPOINT_CONFIRM");
        }
        assertThat(putAudio(putUrl, "audio/wav", replacement)).isBetween(200, 299);
        assertThat(putAudio(second.get("uploadUrl").asText(), "audio/wav", replacement)).isBetween(200, 299);
        String access = fixture.path() + "/audio/" + winner + "/access";
        assertThat(get(access, fixture.listener()).statusCode()).isEqualTo(403);
        assertThat(get(access, session()).statusCode()).isEqualTo(403);
        var allowed = get(access, fixture.speaker());
        assertThat(allowed.statusCode()).isEqualTo(200);
        assertThat(allowed.headers().firstValue("cache-control")).contains("no-store");
        var recordedAudio = HTTP.send(HttpRequest.newBuilder(URI.create(body(allowed).get("url").asText()))
                .timeout(Duration.ofSeconds(10)).GET().build(), HttpResponse.BodyHandlers.ofByteArray());
        assertThat(recordedAudio.statusCode()).isEqualTo(200);
        assertThat(recordedAudio.body()).isEqualTo(original);
        assertThat(body(get(fixture.room(), fixture.speaker())).get("speakerAudioId").asText()).isEqualTo(winner);
        assertThat(database.queryForObject("SELECT COUNT(*) FROM audio_assets WHERE round_id = ? AND object_key IS NOT NULL",
                Integer.class, fixture.roundId())).isEqualTo(1);
        database.update("UPDATE rounds SET stage = 'LISTENER_RETELL', deadline_at = NULL WHERE id = ?", fixture.roundId());
        assertThat(get(access, fixture.listener()).statusCode()).isEqualTo(200);
    }

    @Test void listenerUploadRequiresConsentAndOldSpeakerDraftIsRejectedAfterRestart() throws Exception {
        var fixture = recordingRoom();
        byte[] audio = sampleWave((short) 100);
        String route = fixture.path() + "/uploads";
        var draft = body(post(route, Map.of("kind", "speaker", "mimeType", "audio/wav", "byteSize", audio.length,
                "idempotencyKey", UUID.randomUUID()), fixture.speaker()));
        assertThat(putAudio(draft.get("uploadUrl").asText(), "audio/wav", audio)).isBetween(200, 299);
        assertThat(post(fixture.path() + "/restart-recording", Map.of("expectedVersion", fixture.version(), "kind", "speaker"),
                fixture.speaker()).statusCode()).isEqualTo(200);
        var stale = post(route + "/" + draft.get("audioId").asText() + "/commit", Map.of("expectedVersion", fixture.version()), fixture.speaker());
        assertThat(stale.statusCode()).isEqualTo(409);
        assertThat(body(stale).get("error").asText()).isEqualTo("STALE_AUDIO");

        // Points confirmation is a later slice. Establish the state at its boundary.
        database.update("UPDATE rounds SET stage = 'LISTENER_RETELL', deadline_at = NULL, version = version + 1 WHERE id = ?",
                fixture.roundId());
        var listenerUpload = Map.of("kind", "listener", "mimeType", "audio/wav", "byteSize", audio.length,
                "idempotencyKey", UUID.randomUUID());
        assertThat(body(post(route, listenerUpload, fixture.listener())).get("error").asText())
                .isEqualTo("RECORDING_WINDOW_CLOSED");
        var listenerStart = post(fixture.path() + "/restart-recording",
                Map.of("expectedVersion", fixture.version() + 2, "kind", "listener"), fixture.listener());
        assertThat(listenerStart.statusCode()).isEqualTo(200);
        var recording = body(listenerStart);
        assertThat(recording.get("stage").asText()).isEqualTo("LISTENER_RETELL");
        assertThat(Instant.parse(recording.get("deadlineAt").asText())).isAfter(Instant.now().plusSeconds(25));
        long version = recording.get("version").asLong();
        var requested = post(route, listenerUpload, fixture.listener());
        assertThat(requested.statusCode()).isEqualTo(200);
        var listener = body(requested);
        assertThat(putAudio(listener.get("uploadUrl").asText(), "audio/wav", audio)).isBetween(200, 299);
        String confirm = route + "/" + listener.get("audioId").asText() + "/commit";
        assertThat(body(post(confirm, Map.of("expectedVersion", version), fixture.listener())).get("error").asText())
                .isEqualTo("CONSENT_REQUIRED");
        var result = post(confirm, Map.of("expectedVersion", version, "consentToTranscribe", true), fixture.listener());
        assertThat(result.statusCode()).isEqualTo(200);
        assertThat(body(result).at("/round/stage").asText()).isEqualTo("COMPARING");
    }

    @Test void committedRecordingsAreTranscribedAndConfirmedPointsOpenListenerSeat() throws Exception {
        var fixture = recordingRoom();
        String path = fixture.path();
        var speaker = uploadForProcessing(fixture, "speaker", fixture.speaker(), fixture.version(), true);
        String speakerId = speaker.get("audioId").asText();
        assertThat(database.queryForObject("SELECT COUNT(*) FROM transcription_jobs WHERE audio_id = ?", Integer.class,
                speakerId)).isEqualTo(1);
        var forbidden = get(path + "/speaker-transcript", fixture.listener());
        assertThat(forbidden.statusCode()).isEqualTo(403);
        var ready = awaitTranscript(path + "/speaker-transcript", fixture.speaker());
        assertThat(ready.get("text").asText()).contains("演示转写");
        byte[] sealed = database.queryForObject("SELECT result_ciphertext FROM transcription_jobs WHERE audio_id = ?",
                byte[].class, speakerId);
        assertThat(sealed).isNotNull();
        assertThat(new String(sealed, StandardCharsets.UTF_8)).doesNotContain("演示转写");

        long version = speaker.at("/round/version").asLong();
        var points = Map.of("expectedVersion", version, "points", java.util.List.of(
                Map.of("category", "需求", "text", "周六先看望家人，再决定是否聚餐")));
        assertThat(post(path + "/points/confirm", points, fixture.listener()).statusCode()).isEqualTo(403);
        var confirmed = post(path + "/points/confirm", points, fixture.speaker());
        assertThat(confirmed.statusCode()).isEqualTo(200);
        assertThat(body(confirmed).at("/round/stage").asText()).isEqualTo("LISTENER_RETELL");
        assertThat(body(confirmed).at("/round/deadlineAt").isNull()).isTrue();
        assertThat(body(post(path + "/points/confirm", points, fixture.speaker())).at("/points/0/id"))
                .isEqualTo(body(confirmed).at("/points/0/id"));
        assertThat(post(path + "/points/confirm", Map.of("expectedVersion", version, "points", java.util.List.of(
                Map.of("category", "事情", "text", "不在允许的分类中"))), fixture.speaker()).statusCode()).isEqualTo(400);
        assertThat(get(path + "/points", fixture.listener()).statusCode()).isEqualTo(403);
        assertThat(get(path + "/audio/" + speakerId + "/access", fixture.listener()).statusCode()).isEqualTo(200);
        assertThat(post(path + "/listening-aid", Map.of("kind", "replay"), fixture.listener()).statusCode()).isEqualTo(200);
        var begun = body(post(path + "/restart-recording", Map.of("expectedVersion", version + 1, "kind", "listener"),
                fixture.listener()));
        var listener = uploadForProcessing(fixture, "listener", fixture.listener(), begun.get("version").asLong(), true);
        String listenerId = listener.get("audioId").asText();
        assertThat(listener.at("/round/stage").asText()).isEqualTo("COMPARING");
        org.awaitility.Awaitility.await().atMost(Duration.ofSeconds(10)).until(() -> {
            worker.runOne();
            return "DONE".equals(database.queryForObject("SELECT status FROM transcription_jobs WHERE audio_id = ?", String.class, listenerId));
        });
        org.awaitility.Awaitility.await().atMost(Duration.ofSeconds(8)).untilAsserted(() ->
                assertThat(get(path + "/comparison", fixture.speaker()).statusCode()).isEqualTo(200));
        var comparison = body(get(path + "/comparison", fixture.speaker()));
        assertThat(comparison.at("/total").asInt()).isEqualTo(1);
        assertThat(comparison.at("/complete").asInt()).isZero();
        assertThat(comparison.at("/issues/0/speakerQuote").asText()).contains("先看望家人");
        assertThat(comparison.at("/issues/0/listenerQuote").asText()).contains("讨论聚餐安排");
        String issue = comparison.at("/issues/0/id").asText();
        long reviewVersion = listener.at("/round/version").asLong() + 1;
        var label = Map.of("expectedVersion", reviewVersion, "labels", java.util.List.of(
                Map.of("issueId", issue, "tag", "理解偏了", "resolution", "misunderstanding")));
        String review = path + "/review/";
        assertThat(get(path + "/comparison", session()).statusCode()).isEqualTo(403);
        assertThat(post(review + "label", label, fixture.listener()).statusCode()).isEqualTo(403);
        assertThat(post(review + "label", label, fixture.speaker()).statusCode()).isEqualTo(200);
        assertThat(post(review + "confirm", Map.of("expectedVersion", ++reviewVersion, "issueId", issue),
                fixture.speaker()).statusCode()).isEqualTo(200);
        assertThat(post(review + "submit", Map.of("expectedVersion", ++reviewVersion),
                fixture.speaker()).statusCode()).isEqualTo(409);
        assertThat(post(review + "confirm", Map.of("expectedVersion", reviewVersion - 1, "issueId", issue),
                fixture.listener()).statusCode()).isEqualTo(409);
        assertThat(post(review + "clarify", Map.of("expectedVersion", reviewVersion, "issueId", issue,
                "note", "没有说清聚餐的前提"), fixture.listener()).statusCode()).isEqualTo(200);
        var clarified = body(get(path + "/comparison", fixture.speaker()));
        assertThat(clarified.at("/issues/0/speakerConfirmed").asBoolean()).isFalse();
        assertThat(clarified.at("/issues/0/listenerNote").asText()).isEqualTo("没有说清聚餐的前提");
        assertThat(post(review + "confirm", Map.of("expectedVersion", ++reviewVersion, "issueId", issue),
                fixture.speaker()).statusCode()).isEqualTo(200);
        ++reviewVersion;
        assertThat(post(review + "confirm", Map.of("expectedVersion", reviewVersion, "issueId", issue),
                fixture.listener()).statusCode()).isEqualTo(200);
        assertThat(post(review + "submit", Map.of("expectedVersion", ++reviewVersion),
                fixture.listener()).statusCode()).isEqualTo(403);
        assertThat(post(review + "submit", Map.of("expectedVersion", reviewVersion),
                fixture.speaker()).statusCode()).isEqualTo(200);
        var archived = post(fixture.room() + "/next-round",
                Map.of("roundId", fixture.roundId(), "expectedVersion", ++reviewVersion), fixture.speaker());
        assertThat(archived.statusCode()).isEqualTo(200);
        var report = body(get(path + "/comparison", fixture.listener()));
        assertThat(report.at("/report/listenerAudioId").asText()).isEqualTo(listenerId);
        assertThat(report.at("/issues/0/listenerConfirmed").asBoolean()).isTrue();
        assertThat(database.queryForObject("SELECT COUNT(*) FROM round_comparisons WHERE round_id = ?",
                Integer.class, fixture.roundId())).isEqualTo(1);
    }

    @Test void expiredComparisonReturnsRoomToWaitingWithoutProducingAReport() throws Exception {
        var fixture = recordingRoom();
        var speaker = uploadForProcessing(fixture, "speaker", fixture.speaker(), fixture.version(), true);
        String path = fixture.path();
        long version = speaker.at("/round/version").asLong();
        assertThat(post(path + "/points/confirm", Map.of("expectedVersion", version, "points", java.util.List.of(
                Map.of("category", "重点", "text", "周六先看望家人"))), fixture.speaker()).statusCode()).isEqualTo(200);
        var begun = body(post(path + "/restart-recording", Map.of("expectedVersion", version + 1, "kind", "listener"),
                fixture.listener()));
        var listener = uploadForProcessing(fixture, "listener", fixture.listener(), begun.get("version").asLong(), true);
        assertThat(get(path + "/comparison", fixture.speaker()).statusCode()).isEqualTo(409);
        String listenerId = listener.get("audioId").asText();
        makeJobDue(listenerId);
        var late = queue.claim("mock");
        assertThat(late.audioId()).isEqualTo(listenerId);
        database.update("UPDATE rounds SET deadline_at = TIMESTAMPADD(SECOND, -1, CURRENT_TIMESTAMP(6)) WHERE id = ?",
                fixture.roundId());
        assertThat(queue.startProvider(late)).isFalse();
        assertThat(queue.complete(late, "到期后返回的复述转写")).isFalse();
        org.awaitility.Awaitility.await().atMost(Duration.ofSeconds(8)).untilAsserted(() -> {
            var snapshot = body(get(fixture.room(), fixture.speaker()));
            assertThat(snapshot.get("status").asText()).isEqualTo("WAITING");
            assertThat(snapshot.get("terminalReason").asText()).isEqualTo("COMPARISON_FAILED");
            assertThat(snapshot.get("deadlineAt").isNull()).isTrue();
            assertThat(snapshot.at("/you/ready").asBoolean()).isFalse();
        });
        assertThat(database.queryForObject("SELECT COUNT(*) FROM round_comparisons WHERE round_id = ?",
                Integer.class, fixture.roundId())).isZero();
        assertThat(database.queryForObject("SELECT COUNT(*) FROM transcription_jobs WHERE round_id = ? AND status = 'CANCELLED'",
                Integer.class, fixture.roundId())).isEqualTo(2);
    }

    @Test void reclaimedJobDiscardsExpiredWorkerResultAndClosedRoomResult() throws Exception {
        var fixture = recordingRoom();
        String id = uploadForProcessing(fixture, "speaker", fixture.speaker(), fixture.version(), true).get("audioId").asText();
        makeJobDue(id);
        var stale = queue.claim("mock");
        assertThat(stale.audioId()).isEqualTo(id);
        makeJobDue(id);
        var current = queue.claim("mock");
        assertThat(current.audioId()).isEqualTo(id);
        assertThat(current.token()).isNotEqualTo(stale.token());
        assertThat(queue.complete(stale, "过期结果")).isFalse();
        assertThat(queue.complete(current, "新结果")).isTrue();
        var transcript = body(get(fixture.path() + "/speaker-transcript", fixture.speaker()));
        assertThat(transcript.get("text").asText()).isEqualTo("新结果");

        var closing = recordingRoom();
        String closingId = uploadForProcessing(closing, "speaker", closing.speaker(), closing.version(), true).get("audioId").asText();
        makeJobDue(closingId);
        var closingLease = queue.claim("mock");
        assertThat(closingLease.audioId()).isEqualTo(closingId);
        assertThat(post(closing.room() + "/leave", Map.of(), closing.speaker()).statusCode()).isEqualTo(200);
        assertThat(queue.complete(closingLease, "关闭后才返回的结果")).isFalse();
        assertThat(database.queryForObject("SELECT status FROM transcription_jobs WHERE audio_id = ?", String.class, closingId))
                .isEqualTo("CANCELLED");
    }

    @Test void retriesAreBoundedAndManualPointsRemainAvailable() throws Exception {
        var fixture = recordingRoom();
        String id = uploadForProcessing(fixture, "speaker", fixture.speaker(), fixture.version(), true).get("audioId").asText();
        for (int attempt = 1; attempt <= 3; attempt++) {
            makeJobDue(id);
            var lease = queue.claim("mock");
            assertThat(lease.audioId()).isEqualTo(id);
            assertThat(queue.retry(lease)).isTrue();
            assertThat(database.queryForObject("SELECT attempts FROM transcription_jobs WHERE audio_id = ?", Integer.class, id))
                    .isEqualTo(attempt);
        }
        var transcript = body(get(fixture.path() + "/speaker-transcript", fixture.speaker()));
        assertThat(transcript.get("status").asText()).isEqualTo("failed");
        var points = Map.of("expectedVersion", fixture.version() + 1, "points", java.util.List.of(
                Map.of("category", "事件", "text", "手动确认的要点")));
        assertThat(post(fixture.path() + "/points/confirm", points, fixture.speaker()).statusCode()).isEqualTo(200);
    }

    @Test void listenerGetsOnlyShortHintsAfterExplicitlyRevealingThem() throws Exception {
        var fixture = recordingRoom("keywords");
        uploadForProcessing(fixture, "speaker", fixture.speaker(), fixture.version(), true);
        String path = fixture.path();
        var points = Map.of("expectedVersion", fixture.version() + 1, "points", java.util.List.of(
                Map.of("category", "需求", "text", "周六先看望家人，再决定是否聚餐")));
        assertThat(post(path + "/points/confirm", points, fixture.speaker()).statusCode()).isEqualTo(200);
        assertThat(get(path + "/points", fixture.listener()).statusCode()).isEqualTo(403);
        assertThat(post(path + "/listening-aid", Map.of("kind", "keywords"), fixture.listener()).statusCode()).isEqualTo(200);
        assertThat(body(get(path + "/points", fixture.listener())).at("/0/text").asText()).isEqualTo("周六先看望家…");
        assertThat(body(get(path + "/points", fixture.speaker())).at("/0/text").asText()).isEqualTo("周六先看望家人，再决定是否聚餐");
        assertThat(get(path + "/points", session()).statusCode()).isEqualTo(403);
    }

    private void makeJobDue(String audioId) {
        database.update("UPDATE transcription_jobs SET available_at = TIMESTAMPADD(HOUR, -1, CURRENT_TIMESTAMP(6)) WHERE audio_id = ?", audioId);
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "ECHO_TEST_FFMPEG", matches = ".+")
    void fileAsrResumesWithPersistedTaskAndCleansOnlyItsNormalizedObject() throws Exception {
        exerciseFileAsr(false);
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "ECHO_TEST_FFMPEG", matches = ".+")
    void uncertainFileAsrSubmissionQueriesClientIdWithoutSubmittingAgain() throws Exception {
        exerciseFileAsr(true);
    }

    private void exerciseFileAsr(boolean uncertain) throws Exception {
        var fixture = recordingRoom();
        var speaker = uploadForProcessing(fixture, "speaker", fixture.speaker(), fixture.version(), true);
        String audioId = speaker.get("audioId").asText();
        String vendorId = UUID.randomUUID().toString();
        var submits = new AtomicInteger();
        var queries = new AtomicInteger();
        var signedUrl = new AtomicReference<URI>();
        var remote = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        remote.createContext("/submit", exchange -> {
            submits.incrementAndGet();
            var data = JSON.readTree(exchange.getRequestBody());
            signedUrl.set(URI.create(data.at("/audio/url").asText()));
            if (!audioId.equals(exchange.getRequestHeaders().getFirst("X-Api-Request-Id"))) {
                replyAsr(exchange, 403, "45000001", "{}");
            } else if (uncertain) {
                replyAsr(exchange, 503, "55000031", "{}");
            } else {
                replyAsr(exchange, 200, "20000000", "{\"task_id\":\"" + vendorId + "\"}");
            }
        });
        remote.createContext("/query", exchange -> {
            String expected = uncertain ? audioId : vendorId;
            if (!expected.equals(exchange.getRequestHeaders().getFirst("X-Api-Request-Id"))) {
                replyAsr(exchange, 403, "45000001", "{}");
                return;
            }
            if (queries.incrementAndGet() == 1) replyAsr(exchange, 200, "20000002", "{}");
            else replyAsr(exchange, 200, "20000000", "{\"result\":{\"text\":\"真实转码路径测试。\"}}");
        });
        remote.start();
        try {
            var endpoint = URI.create("http://127.0.0.1:" + remote.getAddress().getPort() + "/");
            var converter = new FfmpegAudio(System.getenv("ECHO_TEST_FFMPEG"), Duration.ofSeconds(10));
            var firstWorker = new TranscriptionWorker(queue, Optional.of(new VolcTranscription(queue,
                    objectStorage, converter, new VolcFileAsr(HTTP, JSON, endpoint, "test-key", "test-resource",
                    Duration.ofSeconds(4)))), "volc");
            makeJobDue(audioId);
            assertThat(queue.claim("volc")).isNull();
            database.update("UPDATE transcription_jobs SET provider = 'volc', attempts = ? WHERE audio_id = ?",
                    uncertain ? 2 : 0, audioId);
            firstWorker.runOne();
            assertThat(submits).hasValue(1);
            assertThat(transcriptionJobs.byId(audioId).status()).isEqualTo("PENDING");
            assertThat(transcriptionJobs.byId(audioId).attempts()).isEqualTo(uncertain ? 1 : 0);
            assertThat(database.queryForObject("SELECT provider_task_id FROM transcription_jobs WHERE audio_id = ?",
                    String.class, audioId)).isEqualTo(uncertain ? null : vendorId);
            assertThat(signedUrl.get().getQuery()).contains("X-Amz-Expires=180");
            var received = HTTP.send(HttpRequest.newBuilder(signedUrl.get()).GET().build(), HttpResponse.BodyHandlers.ofByteArray());
            assertThat(received.statusCode()).isEqualTo(200);
            assertThat(AudioFormat.detect(received.body())).isEqualTo("audio/mpeg");

            var resumedWorker = new TranscriptionWorker(queue, Optional.of(new VolcTranscription(queue,
                    objectStorage, converter, new VolcFileAsr(HTTP, JSON, endpoint, "test-key", "test-resource",
                    Duration.ofSeconds(4)))), "volc");
            makeJobDue(audioId);
            resumedWorker.runOne();
            assertThat(transcriptionJobs.byId(audioId).status()).isEqualTo("PENDING");
            makeJobDue(audioId);
            resumedWorker.runOne();
            assertThat(submits).hasValue(1);
            assertThat(queries).hasValue(2);
            var transcript = body(get(fixture.path() + "/speaker-transcript", fixture.speaker()));
            assertThat(transcript.get("text").asText()).isEqualTo("真实转码路径测试。");

            database.update("UPDATE transcription_jobs SET artifact_cleanup_after = CURRENT_TIMESTAMP(6) WHERE audio_id = ?", audioId);
            cleanup.sweep();
            assertThat(HTTP.send(HttpRequest.newBuilder(signedUrl.get()).GET().build(),
                    HttpResponse.BodyHandlers.discarding()).statusCode()).isEqualTo(404);
            assertThat(get(fixture.path() + "/audio/" + audioId + "/access", fixture.speaker()).statusCode()).isEqualTo(200);
        } finally {
            remote.stop(0);
        }
    }

    private static void replyAsr(HttpExchange exchange, int status, String asrStatus, String json) throws IOException {
        try (exchange) {
            exchange.getResponseHeaders().set("X-Api-Status-Code", asrStatus);
            byte[] output = json.getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(status, output.length);
            exchange.getResponseBody().write(output);
        }
    }

    private JsonNode uploadForProcessing(RecordingFixture fixture, String kind, String actor, long version,
                                         boolean consent) throws Exception {
        byte[] wav = sampleWave((short) 200);
        String uploads = fixture.path() + "/uploads";
        var requested = post(uploads, Map.of("kind", kind, "mimeType", "audio/wav", "byteSize", wav.length,
                "idempotencyKey", UUID.randomUUID()), actor);
        assertThat(requested.statusCode()).isEqualTo(200);
        var uploaded = body(requested);
        assertThat(putAudio(uploaded.get("uploadUrl").asText(), "audio/wav", wav)).isBetween(200, 299);
        var committed = post(uploads + "/" + uploaded.get("audioId").asText() + "/commit",
                Map.of("expectedVersion", version, "consentToTranscribe", consent), actor);
        assertThat(committed.statusCode()).isEqualTo(200);
        return body(committed);
    }

    private JsonNode awaitTranscript(String path, String actor) {
        return org.awaitility.Awaitility.await().atMost(Duration.ofSeconds(10)).until(() -> {
            worker.runOne();
            var response = get(path, actor);
            assertThat(response.statusCode()).isEqualTo(200);
            return body(response);
        }, value -> "ready".equals(value.path("status").asText()));
    }

    private record RecordingFixture(String room, String roundId, String speaker, String listener, long version) {
        String path() { return "/api/rounds/" + roundId; }
    }

    private RecordingFixture recordingRoom() throws Exception {
        return recordingRoom("auditory");
    }

    private RecordingFixture recordingRoom(String style) throws Exception {
        String speaker = session();
        String listener = session();
        var created = body(post("/api/rooms", Map.of("mode", "sync", "createKey", UUID.randomUUID(), "retellStyle", style), speaker));
        String room = "/api/rooms/" + created.at("/state/id").asText();
        assertThat(post("/api/rooms/join", Map.of("token", created.get("inviteToken").asText()), listener).statusCode()).isEqualTo(200);
        assertThat(post(room + "/ready", Map.of("ready", true), speaker).statusCode()).isEqualTo(200);
        assertThat(post(room + "/ready", Map.of("ready", true), listener).statusCode()).isEqualTo(200);
        var started = body(post(room + "/start", Map.of(), speaker));
        String roundId = started.get("roundId").asText();
        var recording = post("/api/rounds/" + roundId + "/task", Map.of("expectedVersion", started.get("roundVersion").asLong()), speaker);
        assertThat(recording.statusCode()).isEqualTo(200);
        return new RecordingFixture(room, roundId, speaker, listener, body(recording).get("version").asLong());
    }

    private static byte[] sampleWave(short sample) {
        int size = 320;
        var wave = ByteBuffer.allocate(44 + size).order(ByteOrder.LITTLE_ENDIAN);
        wave.put("RIFF".getBytes(StandardCharsets.US_ASCII)).putInt(size + 36);
        wave.put("WAVEfmt ".getBytes(StandardCharsets.US_ASCII)).putInt(16).putShort((short) 1).putShort((short) 1);
        wave.putInt(16000).putInt(32000).putShort((short) 2).putShort((short) 16);
        wave.put("data".getBytes(StandardCharsets.US_ASCII)).putInt(size);
        while (wave.hasRemaining()) wave.putShort(sample);
        return wave.array();
    }

    private int putAudio(String url, String mime, byte[] bytes) throws Exception {
        return HTTP.send(HttpRequest.newBuilder(URI.create(url)).timeout(Duration.ofSeconds(10))
                .header("Content-Type", mime).PUT(HttpRequest.BodyPublishers.ofByteArray(bytes)).build(),
                HttpResponse.BodyHandlers.discarding()).statusCode();
    }

    private HttpResponse<String> get(String path, String cookie) throws Exception {
        return HTTP.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path)).timeout(Duration.ofSeconds(10))
                .header("Cookie", cookie).GET().build(), HttpResponse.BodyHandlers.ofString());
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
