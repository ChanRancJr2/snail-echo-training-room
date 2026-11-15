package io.snailecho;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Base64;
import java.util.HexFormat;
import java.util.UUID;
import java.util.regex.Pattern;

import org.springframework.stereotype.Service;

@Service
public class SessionService {
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final Pattern TOKEN = Pattern.compile("[A-Za-z0-9_-]{43}");
    private final RoomMapper database;

    SessionService(RoomMapper database) {
        this.database = database;
    }

    record Session(String id, String nickname, Instant expiresAt) {}
    record Issued(Session session, String token) {}

    Issued create(String nickname) {
        String token = newToken();
        String name = nickname == null || nickname.isBlank() ? "访客" : nickname.strip();
        var session = new Session(UUID.randomUUID().toString(), name, Instant.now().plus(12, ChronoUnit.HOURS));
        database.insertSession(session, hash(token));
        return new Issued(session, token);
    }

    Session require(String token) {
        var session = validToken(token) ? database.findSession(hash(token)) : null;
        if (session == null || !session.expiresAt().isAfter(Instant.now())) {
            throw new ApiFailure(401, "UNAUTHENTICATED");
        }
        return session;
    }

    static boolean validToken(String token) {
        return token != null && TOKEN.matcher(token).matches();
    }

    static String newToken() {
        byte[] bytes = new byte[32];
        RANDOM.nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    static String hash(String token) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(token.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException("SHA-256 unavailable", error);
        }
    }
}
