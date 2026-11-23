package io.snailecho;

import java.io.IOException;
import java.net.URI;
import java.time.Duration;
import java.util.UUID;

import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.core.exception.SdkException;
import software.amazon.awssdk.core.sync.RequestBody;
import software.amazon.awssdk.http.urlconnection.UrlConnectionHttpClient;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.S3Configuration;
import software.amazon.awssdk.services.s3.model.S3Exception;
import software.amazon.awssdk.services.s3.presigner.S3Presigner;

@Component
@ConditionalOnProperty(name = "echo.storage.enabled", havingValue = "true")
class S3AudioStorage {
    static final int DOWNLOAD_SECONDS = 60;
    private static final Logger LOG = LoggerFactory.getLogger(S3AudioStorage.class);
    private final String bucket;
    private final S3Client client;
    private final S3Presigner signer;
    private final URI accessibleEndpoint;

    S3AudioStorage(@Value("${echo.storage.endpoint}") URI endpoint,
                   @Value("${echo.storage.public-endpoint:}") String publicEndpoint,
                   @Value("${echo.storage.region:us-east-1}") String region,
                   @Value("${echo.storage.bucket}") String bucket,
                   @Value("${echo.storage.access-key}") String accessKey,
                   @Value("${echo.storage.secret-key}") String secretKey) {
        this.bucket = bucket;
        var credentials = StaticCredentialsProvider.create(AwsBasicCredentials.create(accessKey, secretKey));
        var s3Config = S3Configuration.builder().pathStyleAccessEnabled(true).checksumValidationEnabled(false).build();
        var awsRegion = Region.of(region);
        client = S3Client.builder().region(awsRegion).endpointOverride(endpoint).credentialsProvider(credentials)
                .serviceConfiguration(s3Config)
                .httpClientBuilder(UrlConnectionHttpClient.builder().connectionTimeout(Duration.ofSeconds(3))
                        .socketTimeout(Duration.ofSeconds(12)))
                .overrideConfiguration(c -> c.apiCallTimeout(Duration.ofSeconds(20))
                        .apiCallAttemptTimeout(Duration.ofSeconds(12)))
                .build();
        accessibleEndpoint = publicEndpoint.isBlank() ? endpoint : URI.create(publicEndpoint);
        signer = S3Presigner.builder().region(awsRegion).credentialsProvider(credentials)
                .endpointOverride(accessibleEndpoint)
                .serviceConfiguration(s3Config).build();
    }

    String uploadUrl(AudioMapper.Asset asset) {
        return signer.presignPutObject(p -> p.signatureDuration(Duration.ofMinutes(5))
                .putObjectRequest(r -> r.bucket(bucket).key(asset.stagingKey()).contentLength((long) asset.byteSize())))
                .url().toExternalForm();
    }

    String downloadUrl(String key) {
        return downloadUrl(key, Duration.ofSeconds(DOWNLOAD_SECONDS));
    }

    private String downloadUrl(String key, Duration duration) {
        return signer.presignGetObject(p -> p.signatureDuration(duration)
                .getObjectRequest(r -> r.bucket(bucket).key(key).responseCacheControl("private, no-store")))
                .url().toExternalForm();
    }

    boolean hasHttpsEndpoint() {
        return "https".equalsIgnoreCase(accessibleEndpoint.getScheme());
    }

    byte[] readCommitted(AudioMapper.Asset asset) {
        return readVerified(asset, asset.objectKey());
    }

    static String asrKey(String audioId) {
        return "asr/" + audioId + ".mp3";
    }

    String stageForAsr(String key, byte[] mp3) {
        try {
            client.putObject(r -> r.bucket(bucket).key(key).contentType("audio/mpeg")
                    .cacheControl("private, no-store"), RequestBody.fromBytes(mp3));
            return asrDownloadUrl(key);
        } catch (S3Exception failure) {
            LOG.warn("ASR staging upload rejected by object storage (HTTP {})", failure.statusCode());
            throw new AsrFailure("ASR_STORAGE_UNAVAILABLE", true);
        } catch (SdkException failure) {
            LOG.warn("ASR staging upload failed ({})", failure.getClass().getSimpleName());
            throw new AsrFailure("ASR_STORAGE_UNAVAILABLE", true);
        }
    }

    String asrDownloadUrl(String key) {
        return downloadUrl(key, Duration.ofMinutes(3));
    }

    String seal(AudioMapper.Asset asset) {
        byte[] bytes = readVerified(asset, asset.stagingKey());
        // Each attempt has its own final key. Only the transactional winner is made visible.
        String key = "audio/" + asset.roundId() + "/" + UUID.randomUUID();
        try {
            client.putObject(r -> r.bucket(bucket).key(key).contentType(asset.mimeType())
                    .cacheControl("private, no-store"), RequestBody.fromBytes(bytes));
        } catch (SdkException failure) {
            discard(key);
            throw new ApiFailure(503, "AUDIO_STORAGE_UNAVAILABLE");
        }
        return key;
    }

    void putMaterialCandidate(String key, String mime, byte[] bytes) {
        try {
            client.putObject(r -> r.bucket(bucket).key(key).contentType(mime)
                    .cacheControl("private, no-store"), RequestBody.fromBytes(bytes));
        } catch (SdkException failure) {
            discard(key);
            throw new ApiFailure(503, "AUDIO_STORAGE_UNAVAILABLE");
        }
    }

    private byte[] readVerified(AudioMapper.Asset asset, String key) {
        try (var stream = client.getObject(r -> r.bucket(bucket).key(key))) {
            if (!Long.valueOf(asset.byteSize()).equals(stream.response().contentLength())
                    || !asset.mimeType().equals(AudioFormat.mime(stream.response().contentType()))) {
                stream.abort();
                throw new ApiFailure(409, "UPLOAD_NOT_VERIFIED");
            }
            byte[] bytes = stream.readNBytes(asset.byteSize() + 1);
            if (bytes.length != asset.byteSize()) {
                stream.abort();
                throw new ApiFailure(409, "UPLOAD_NOT_VERIFIED");
            }
            if (!asset.mimeType().equals(AudioFormat.detect(bytes))) throw new ApiFailure(400, "UNSUPPORTED_AUDIO");
            return bytes;
        } catch (S3Exception missing) {
            if (missing.statusCode() == 404) throw new ApiFailure(409, "UPLOAD_NOT_VERIFIED");
            throw new ApiFailure(503, "AUDIO_STORAGE_UNAVAILABLE");
        } catch (SdkException | IOException failure) {
            throw new ApiFailure(503, "AUDIO_STORAGE_UNAVAILABLE");
        }
    }

    boolean discard(String key) {
        try {
            client.deleteObject(r -> r.bucket(bucket).key(key));
            return true;
        } catch (SdkException failure) {
            LOG.warn("Unable to clean up an unreferenced audio object");
            return false;
        }
    }

    @PreDestroy
    void close() {
        signer.close();
        client.close();
    }
}
