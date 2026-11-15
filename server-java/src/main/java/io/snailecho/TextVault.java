package io.snailecho;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import java.util.Base64;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

@Component
@ConditionalOnProperty(name = "echo.processing.enabled", havingValue = "true")
class TextVault {
    private static final byte FORMAT_VERSION = 1;
    private static final int NONCE_LENGTH = 12;
    private final SecureRandom random = new SecureRandom();
    private final SecretKeySpec key;

    TextVault(@Value("${echo.processing.master-key:}") String encoded) {
        byte[] material;
        try {
            material = Base64.getDecoder().decode(encoded);
        } catch (IllegalArgumentException invalid) {
            throw new IllegalStateException("JAVA_TEXT_MASTER_KEY must be a Base64-encoded 32-byte key");
        }
        if (material.length != 32) throw new IllegalStateException("JAVA_TEXT_MASTER_KEY must contain 32 bytes");
        key = new SecretKeySpec(material, "AES");
    }

    byte[] seal(String scope, String text) {
        byte[] nonce = new byte[NONCE_LENGTH];
        random.nextBytes(nonce);
        byte[] sealed = crypt(Cipher.ENCRYPT_MODE, nonce, scope, text.getBytes(StandardCharsets.UTF_8));
        return ByteBuffer.allocate(1 + nonce.length + sealed.length).put(FORMAT_VERSION).put(nonce).put(sealed).array();
    }

    String open(String scope, byte[] packed) {
        if (packed == null || packed.length < 1 + NONCE_LENGTH + 16 || packed[0] != FORMAT_VERSION) {
            throw new IllegalStateException("Invalid sealed text");
        }
        var input = ByteBuffer.wrap(packed, 1, packed.length - 1);
        byte[] nonce = new byte[NONCE_LENGTH];
        byte[] sealed = new byte[packed.length - 1 - NONCE_LENGTH];
        input.get(nonce).get(sealed);
        return new String(crypt(Cipher.DECRYPT_MODE, nonce, scope, sealed), StandardCharsets.UTF_8);
    }

    private byte[] crypt(int mode, byte[] nonce, String scope, byte[] bytes) {
        try {
            var cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(mode, key, new GCMParameterSpec(128, nonce));
            cipher.updateAAD(scope.getBytes(StandardCharsets.UTF_8));
            return cipher.doFinal(bytes);
        } catch (GeneralSecurityException error) {
            throw new IllegalStateException("Unable to process sealed text");
        }
    }
}
