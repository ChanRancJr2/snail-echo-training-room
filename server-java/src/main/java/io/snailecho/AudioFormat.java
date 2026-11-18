package io.snailecho;

import java.util.Locale;
import java.util.Set;

import org.springframework.http.MediaType;

final class AudioFormat {
    static final int MAX_BYTES = 15_000_000;
    private static final Set<String> SUPPORTED = Set.of("audio/webm", "audio/mp4", "audio/mpeg",
            "audio/wav", "audio/ogg", "audio/aac");

    private AudioFormat() {}

    static String mime(String raw) {
        if (raw == null) return null;
        try {
            var parsed = MediaType.parseMediaType(raw);
            String mime = (parsed.getType() + "/" + parsed.getSubtype()).toLowerCase(Locale.ROOT);
            return SUPPORTED.contains(mime) ? mime : null;
        } catch (IllegalArgumentException invalid) {
            return null;
        }
    }

    static String detect(byte[] bytes) {
        if (bytes.length < 16) return null;
        if (at(bytes, 0, 0x1a, 0x45, 0xdf, 0xa3)) return "audio/webm";
        if (at(bytes, 0, 'O', 'g', 'g', 'S')) return "audio/ogg";
        if (at(bytes, 4, 'f', 't', 'y', 'p')) return "audio/mp4";
        if (at(bytes, 0, 'R', 'I', 'F', 'F') && at(bytes, 8, 'W', 'A', 'V', 'E')) return "audio/wav";
        if (at(bytes, 0, 'I', 'D', '3')) return "audio/mpeg";
        int second = Byte.toUnsignedInt(bytes[1]);
        if (Byte.toUnsignedInt(bytes[0]) == 255) {
            if ((second & 246) == 240) return "audio/aac";
            if ((second & 224) == 224 && (second & 6) != 0) return "audio/mpeg";
        }
        return null;
    }

    private static boolean at(byte[] bytes, int offset, int... signature) {
        for (int i = 0; i < signature.length; i++) {
            if (Byte.toUnsignedInt(bytes[offset + i]) != signature[i]) return false;
        }
        return true;
    }
}
