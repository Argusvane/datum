package com.argusvane.datum.examples.webfluxpdf;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import com.argusvane.datum.starter.test.DatumTck;
import com.argusvane.datum.tck.AssetsContract;
import com.argusvane.datum.tck.FormsContract;
import com.argusvane.datum.tck.HostTarget;
import com.argusvane.datum.tck.PdfContract;
import com.argusvane.datum.tck.TsaContract;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.MethodOrderer;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestMethodOrder;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * Story four end to end with the REAL runtime on a real Netty port: the application boots with the Endive runtime
 * (the starter brings it), proves both programs, and prints, fills, seals and verifies PDFs over HTTP, sealing with
 * the development key store the setup script makes. The script is run here as a user runs it (keytool from this JDK),
 * so the example's documented setup is what is tested. The wire contract of the PDF routes, the assets, the forms reads
 * and the timestamp server is the host test kit's (the kit's fixture form is added to the example's
 * forms for this test); what is this example's own (receipts, the PDF bundle, the actuator) is tested here.
 */
@Tag("real-runtime")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
    "datum.web.throttle.limit=100",
    "datum.runtime.pdf.time-limit=60s",
    "datum.forms.locations=classpath:/datum/forms/*.json," + DatumTck.FIXTURE_FORM_LOCATION})
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class PdfExampleIT implements PdfContract, AssetsContract, FormsContract, TsaContract {

    private static final JsonMapper JSON = JsonMapper.builder().build();
    private static final Path STORE_DIR = makeKeyStore();

    @DynamicPropertySource
    static void keyStore(DynamicPropertyRegistry registry) {
        registry.add("spring.ssl.bundle.jks.pdf-signer.keystore.location", () -> "file:" + STORE_DIR.resolve("dev-signer.p12"));
        registry.add("spring.ssl.bundle.jks.pdf-signer.keystore.password", () -> "changeit");
    }

    /** Runs scripts/make-dev-keystore.sh with this JDK's keytool into a fresh directory. */
    private static Path makeKeyStore() {
        try {
            Path dir = Files.createTempDirectory("datum-example-pdf");
            Path script = Path.of(System.getProperty("user.dir")).resolve("scripts/make-dev-keystore.sh");
            assumeTrue(Files.isRegularFile(script), "scripts/make-dev-keystore.sh is not under the working directory.");
            ProcessBuilder builder = new ProcessBuilder("sh", script.toString(), dir.toString()).redirectErrorStream(true);
            builder.environment().put("KEYTOOL", Path.of(System.getProperty("java.home"), "bin", "keytool").toString());
            Process process = builder.start();
            String output = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
            assertThat(process.waitFor(60, TimeUnit.SECONDS)).as(output).isTrue();
            assertThat(process.exitValue()).as(output).isZero();
            return dir;
        } catch (IOException e) {
            throw new IllegalStateException(e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException(e);
        }
    }

    @LocalServerPort
    int port;

    @Override
    public HostTarget target() {
        // The builder is on in this example (SecurityConfiguration decides who builds, with DatumExchangeMatchers), and the server seals with its key store.
        return DatumTck.localBuilder(port).builderEnabled(true).pdfSigning(true).build();
    }

    private HttpResponse<byte[]> send(HttpRequest.Builder request) throws Exception {
        return HttpClient.newHttpClient().send(request.build(), HttpResponse.BodyHandlers.ofByteArray());
    }

    private HttpResponse<byte[]> get(String path) throws Exception {
        return send(HttpRequest.newBuilder(URI.create("http://localhost:" + port + path)).GET());
    }

    private HttpResponse<byte[]> post(String path, String contentType, byte[] body) throws Exception {
        return send(HttpRequest.newBuilder(URI.create("http://localhost:" + port + path)).header("Content-Type", contentType)
            .POST(HttpRequest.BodyPublishers.ofByteArray(body)));
    }

    private HttpResponse<byte[]> postJson(String path, String body) throws Exception {
        return post(path, "application/json", body.getBytes(StandardCharsets.UTF_8));
    }

    private static String text(HttpResponse<byte[]> reply) {
        return new String(reply.body(), StandardCharsets.ISO_8859_1);
    }

    private static final String ENVELOPE = "{\"versionContext\":{\"form\":{\"id\":\"intake\",\"version\":\"1\"},"
        + "\"client\":{\"runtimeVersion\":\"x\",\"rendererVersion\":\"x\",\"schemaVersion\":\"1\"}},"
        + "\"submission\":{\"locale\":\"en\",\"values\":{\"name\":\"Ada Lovelace\",\"email\":\"ada@example.org\",\"request\":\"A copy of my file.\"}}}";

    @Test
    @Order(3)
    void aStoredSubmissionIsIssuedWithTheServersTimestampedSealAndVerifies() throws Exception {
        // The receive body: the document and the key of its submit attempt.
        HttpResponse<byte[]> accepted = postJson("/api/submissions", "{\"document\":" + ENVELOPE + ",\"submissionKey\":\"" + UUID.randomUUID() + "\"}");
        assertThat(accepted.statusCode()).as(text(accepted)).isEqualTo(200);
        String id = JSON.readTree(accepted.body()).path("id").asString();
        assertThat(id).isNotBlank();

        HttpResponse<byte[]> receipt = get("/receipts/" + id + ".pdf");
        assertThat(receipt.statusCode()).as(text(receipt)).isEqualTo(200);
        assertThat(text(receipt)).startsWith("%PDF-");
        assertThat(receipt.headers().firstValue("X-Sealed")).hasValue("true");

        HttpResponse<byte[]> report = post("/api/pdf/verify", "application/pdf", receipt.body());
        assertThat(report.statusCode()).as(text(report)).isEqualTo(200);
        JsonNode body = JSON.readTree(report.body());
        assertThat(body.path("signatures")).hasSize(1);
        JsonNode signature = body.path("signatures").path(0);
        // The seal holds: the bytes are as signed, the digest matches, the value verifies, and the certificate is the site's own.
        assertThat(signature.path("intact").asBoolean()).as(signature.toString()).isTrue();
        assertThat(signature.path("value").asString()).as(signature.toString()).isEqualTo("valid");
        assertThat(signature.path("digestMatches").asBoolean()).as(signature.toString()).isTrue();
        assertThat(signature.path("trust").asString()).as(signature.toString()).isEqualTo("site");
        assertThat(signature.path("signer").path("commonName").asString()).as(signature.toString()).isEqualTo("Datum example PDF signer");
        // The seal carries a token from the application's own timestamp authority (datum.tsa, serials in H2): the receipt says
        // so, and the verifier reads the token as the site's, over this very signature value.
        assertThat(receipt.headers().firstValue("X-Timestamped")).hasValue("true");
        assertThat(signature.path("certificateMatches").asBoolean()).as(signature.toString()).isTrue();
        JsonNode timestamp = signature.path("timestamp");
        assertThat(timestamp.isObject()).as(signature.toString()).isTrue();
        assertThat(timestamp.path("coversSignature").asBoolean()).as(timestamp.toString()).isTrue();
        assertThat(timestamp.path("verified").asBoolean()).as(timestamp.toString()).isTrue();
        assertThat(timestamp.path("trust").asString()).as(timestamp.toString()).isEqualTo("site");
        assertThat(timestamp.path("time").asString()).isNotBlank();
        // The report names the trust policy it was made under: the standard one, chains judged now.
        assertThat(body.path("trustPolicy").path("name").asString()).as(body.toString()).isEqualTo("default");
        assertThat(body.path("trustPolicy").path("revocationChecking").asBoolean()).isFalse();
        assertThat(body.path("trustPolicy").path("validationTime").asString()).isEqualTo("now");
        // A site signer: no chain to an anchor was judged, so no time is claimed.
        assertThat(signature.path("trustedAt").isString()).as(signature.toString()).isFalse();
        // And a flipped byte inside the signed range breaks it.
        byte[] tampered = receipt.body();
        int at = new String(tampered, StandardCharsets.ISO_8859_1).indexOf("/Type") + 1;
        tampered[at] ^= 0x01;
        HttpResponse<byte[]> broken = post("/api/pdf/verify", "application/pdf", tampered);
        if (broken.statusCode() == 200) {
            assertThat(JSON.readTree(broken.body()).path("signatures").path(0).path("intact").asBoolean()).isFalse();
        }
    }

    @Test
    @Order(6)
    void thePdfBundleIsServedBesideTheRenderer() throws Exception {
        // The renderer's files are the assets contract's; the PDF jar's own bundle comes through the same handler.
        JsonNode host = JSON.readTree(get("/datum/assets/host.json").body());
        String base = host.get("assetsBase").asString();
        assertThat(get(base + "/datum-pdf.js").statusCode()).as("the PDF jar's own bundle through the shared handler").isEqualTo(200);
        assertThat(text(get("/"))).contains("<datum-form");
    }

    @Test
    @Order(7)
    void healthAndInfoReportThePdfCapability() throws Exception {
        HttpResponse<byte[]> health = get("/actuator/health");
        assertThat(health.statusCode()).as(text(health)).isEqualTo(200);
        // The health indicator: datum is a composite, one member per check, so each is a component of its own with its status.
        JsonNode components = JSON.readTree(health.body()).path("components").path("datum").path("components");
        assertThat(components.path("pdf").path("status").asString()).as(text(health)).isEqualTo("UP");
        assertThat(components.path("runtime").path("status").asString()).as(text(health)).isEqualTo("UP");
        assertThat(JSON.readTree(get("/actuator/info").body()).path("datum").toString()).contains("pdf");
        // The accepted-submission digests are in the database, as the README says: the store is made after spring.sql.init
        // created V200 (@DependsOnDatabaseInitialization), so its start-up probe finds the table.
        assertThat(JSON.readTree(get("/actuator/info").body()).path("datum").path("idempotency").asString()).isEqualTo("jdbc");
    }
}
