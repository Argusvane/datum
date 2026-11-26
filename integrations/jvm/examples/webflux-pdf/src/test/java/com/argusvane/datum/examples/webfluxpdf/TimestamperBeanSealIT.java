package com.argusvane.datum.examples.webfluxpdf;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import com.argusvane.datum.pdf.verify.PdfTrustPolicy;
import com.argusvane.datum.timestamp.InMemoryTsaLog;
import com.argusvane.datum.timestamp.SelfSignedTsaCertificate;
import com.argusvane.datum.timestamp.TimestampAuthority;
import com.argusvane.datum.timestamp.Timestamper;
import com.argusvane.datum.timestamp.TsaKey;
import com.argusvane.datum.timestamp.TsaKeyMaterial;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.context.annotation.Bean;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * The PDF binding's security seams through a real seal on Netty. The application defines its own
 * {@link Timestamper} (here a recording one in front of an authority of its own: what a qualified or custom timestamp
 * service looks like to the binding) and the binding consults it before it builds its own client: the named server
 * ({@code datum.pdf.signing.tsa.url}, pointed at a port nobody listens on) and the example's in-process authority
 * ({@code datum.tsa}) are both passed over, and the seal's token is the application's. The application's
 * {@link PdfTrustPolicy} bean is the one {@code POST /api/pdf/verify} judges under, and the report names it; with the
 * authority's certificate as a trust anchor the token verifies as {@code trusted}. Real runtime, so it runs in the
 * integration phase beside {@link PdfExampleIT}.
 */
@Tag("real-runtime")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
    "datum.web.throttle.limit=100",
    "datum.runtime.pdf.time-limit=60s",
    "datum.pdf.seal.enabled=true",
    "datum.pdf.seal.timestamp=true",
    // Nobody listens here: a seal that reached for the named server would carry no timestamp.
    "datum.pdf.signing.tsa.url=http://127.0.0.1:9/tsa"})
class TimestamperBeanSealIT {

    private static final JsonMapper JSON = JsonMapper.builder().build();
    private static final TsaKey OWN_TSA = SelfSignedTsaCertificate.create("Application TSA");
    private static final List<String> CHANNELS = new CopyOnWriteArrayList<>();
    private static final Path DIR = makeKeyStoreAndAnchor();

    /** Runs scripts/make-dev-keystore.sh as PdfExampleIT does, and writes the application authority's certificate as a PEM anchor. */
    private static Path makeKeyStoreAndAnchor() {
        try {
            Path dir = Files.createTempDirectory("datum-example-pdf-timestamper");
            Path script = Path.of(System.getProperty("user.dir")).resolve("scripts/make-dev-keystore.sh");
            assumeTrue(Files.isRegularFile(script), "scripts/make-dev-keystore.sh is not under the working directory.");
            ProcessBuilder builder = new ProcessBuilder("sh", script.toString(), dir.toString()).redirectErrorStream(true);
            builder.environment().put("KEYTOOL", Path.of(System.getProperty("java.home"), "bin", "keytool").toString());
            Process process = builder.start();
            String output = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
            assertThat(process.waitFor(60, TimeUnit.SECONDS)).as(output).isTrue();
            assertThat(process.exitValue()).as(output).isZero();
            Files.writeString(dir.resolve("anchor.pem"), TsaKey.pem(OWN_TSA.leaf()), StandardCharsets.US_ASCII);
            return dir;
        } catch (IOException e) {
            throw new IllegalStateException(e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException(e);
        }
    }

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry registry) {
        registry.add("spring.ssl.bundle.jks.pdf-signer.keystore.location", () -> "file:" + DIR.resolve("dev-signer.p12"));
        registry.add("spring.ssl.bundle.jks.pdf-signer.keystore.password", () -> "changeit");
        registry.add("datum.pdf.signing.trust-anchors", () -> "file:" + DIR.resolve("anchor.pem"));
    }

    @TestConfiguration(proxyBeanMethods = false)
    static class Seams {

        /** The application's timestamp service: records who asked, then asks an authority of its own. */
        @Bean
        Timestamper recordingTimestamper() {
            TimestampAuthority own = new TimestampAuthority(TsaKeyMaterial.of(OWN_TSA), null, null, Clock.systemUTC(),
                new InMemoryTsaLog(Clock.systemUTC()));
            return (data, channel) -> {
                CHANNELS.add(channel);
                return own.stamp(data, channel);
            };
        }

        /** The application's trust rules: the configured anchors, judged now, under its own name. */
        @Bean
        PdfTrustPolicy exampleTrustPolicy() {
            return PdfTrustPolicy.builder("example-policy").build();
        }
    }

    @LocalServerPort
    int port;

    @Test
    void theSealIsTimestampedByTheApplicationsTimestamperAndVerifiedUnderItsPolicy() throws Exception {
        String envelope = "{\"versionContext\":{\"form\":{\"id\":\"intake\",\"version\":\"1\"},"
            + "\"client\":{\"runtimeVersion\":\"x\",\"rendererVersion\":\"x\",\"schemaVersion\":\"1\"}},"
            + "\"submission\":{\"locale\":\"en\",\"values\":{\"name\":\"Ada Lovelace\",\"email\":\"ada@example.org\",\"request\":\"A copy of my file.\"}}}";
        HttpClient http = HttpClient.newHttpClient();
        HttpResponse<byte[]> accepted = http.send(HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/api/submissions"))
            .header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString("{\"document\":" + envelope + ",\"submissionKey\":\"" + UUID.randomUUID() + "\"}")).build(), HttpResponse.BodyHandlers.ofByteArray());
        assertThat(accepted.statusCode()).as(new String(accepted.body(), StandardCharsets.UTF_8)).isEqualTo(200);
        String id = JSON.readTree(accepted.body()).path("id").asString();

        HttpResponse<byte[]> receipt = http.send(HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/receipts/" + id + ".pdf")).GET().build(),
            HttpResponse.BodyHandlers.ofByteArray());
        assertThat(receipt.statusCode()).isEqualTo(200);
        assertThat(receipt.headers().firstValue("X-Sealed")).hasValue("true");
        assertThat(receipt.headers().firstValue("X-Timestamped")).as("the token came from the application's Timestamper").hasValue("true");
        assertThat(CHANNELS).as("asked for the seal, by the seal").contains("sealing");

        HttpResponse<byte[]> report = http.send(HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/api/pdf/verify"))
            .header("Content-Type", "application/pdf").POST(HttpRequest.BodyPublishers.ofByteArray(receipt.body())).build(),
            HttpResponse.BodyHandlers.ofByteArray());
        assertThat(report.statusCode()).as(new String(report.body(), StandardCharsets.UTF_8)).isEqualTo(200);
        JsonNode body = JSON.readTree(report.body());
        assertThat(body.path("trustPolicy").path("name").asString()).as(body.toString()).isEqualTo("example-policy");
        JsonNode signature = body.path("signatures").path(0);
        assertThat(signature.path("intact").asBoolean()).as(signature.toString()).isTrue();
        assertThat(signature.path("trust").asString()).as(signature.toString()).isEqualTo("site");
        JsonNode timestamp = signature.path("timestamp");
        assertThat(timestamp.path("verified").asBoolean()).as(timestamp.toString()).isTrue();
        assertThat(timestamp.path("trust").asString()).as("the application's authority, anchored, not the site's").isEqualTo("trusted");
        assertThat(timestamp.path("signer").path("commonName").asString()).isEqualTo("Application TSA");
    }
}
