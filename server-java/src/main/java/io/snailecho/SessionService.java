package io.snailecho;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Base64;
import java.util.HexFormat;
import java.util.UUID;
import java.util.regex.Pattern;

import org.springframework.stereotype.Service;

@Service
public class SessionService {
    private static final Duration GUEST_LIFETIME = Duration.ofHours(12);
    private static final Duration NAMED_LIFETIME = Duration.ofDays(30);
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final Pattern TOKEN = Pattern.compile("[A-Za-z0-9_-]{43}");
    private final RoomMapper database;

    SessionService(RoomMapper database) {
        this.database = database;
    }

    record Session(String id, String nickname, Instant expiresAt, boolean named) {}
    record Issued(Session session, String token) {}

    Issued open(String token, String nickname) {
        var current = find(token);
        if (current != null) {
            if (nickname == null) return new Issued(current, null);
            if (current.named() && current.nickname().equals(nickname)) return new Issued(current, token);
            if (!current.named()) {
                var named = new Session(current.id(), nickname, expiresAfter(NAMED_LIFETIME), true);
                if (database.nameGuest(named, hash(token)) == 1) return new Issued(named, token);
                var latest = find(token);
                if (latest != null && latest.named() && latest.nickname().equals(nickname)) {
                    return new Issued(latest, token);
                }
            }
        }

        String newToken = newToken();
        boolean named = nickname != null;
        var session = new Session(UUID.randomUUID().toString(), named ? nickname : "访客",
                expiresAfter(named ? NAMED_LIFETIME : GUEST_LIFETIME), named);
        database.insertSession(session, hash(newToken));
        return new Issued(session, newToken);
    }

    private static Instant expiresAfter(Duration lifetime) {
        return Instant.now().plus(lifetime).truncatedTo(ChronoUnit.MICROS);
    }

    Session require(String token) {
        var session = find(token);
        if (session == null) {
            throw new ApiFailure(401, "UNAUTHENTICATED");
        }
        return session;
    }

    Session find(String token) {
        var session = validToken(token) ? database.findSession(hash(token)) : null;
        return session != null && session.expiresAt().isAfter(Instant.now()) ? session : null;
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
