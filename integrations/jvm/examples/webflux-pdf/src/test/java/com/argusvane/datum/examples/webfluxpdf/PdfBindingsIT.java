package com.argusvane.datum.examples.webfluxpdf;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import com.argusvane.datum.starter.test.DatumTck;
import com.argusvane.datum.tck.HostTarget;
import com.argusvane.datum.tck.PdfContract;
import com.argusvane.datum.tck.TckFixtures;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.MethodOrderer;
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
 * Two routes on one host, each drawn by its own binding, with the REAL PDF program: the fixture
 * form keeps the default binding ({@code datum}, whose PDF theme is the engine's own {@code datum-pdf}) and its copy
 * {@code datum-security-suite-b} is routed to a binding the host registers ({@code ledger-binding}) whose PDF theme is
 * the kit's {@code datum-host-check-pdf}, supplied from the kit's jar. The kit's per-route PDF contract holds each route's
 * PDF to its catalog PDF theme, in the header and in the drawing (the theme's text colour); what is this host's own (the
 * table in {@code host.json}) is checked here.
 */
@Tag("real-runtime")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
    "datum.web.throttle.limit=100",
    "datum.runtime.pdf.time-limit=60s",
    "datum.forms.locations=classpath:/datum/forms/*.json," + DatumTck.FIXTURE_FORM_LOCATION + "," + DatumTck.FIXTURE_FORM_B_LOCATION,
    "datum.bindings.routes.datum-security-suite-b=ledger-binding",
    "datum.bindings.catalog.ledger-binding.label=Ledger",
    "datum.bindings.catalog.ledger-binding.pdf-theme=" + TckFixtures.PDF_THEME_ID,
    "datum.bindings.pdf-themes." + TckFixtures.PDF_THEME_ID + "=" + DatumTck.FIXTURE_PDF_THEME_LOCATION})
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class PdfBindingsIT implements PdfContract {

    private static final JsonMapper JSON = JsonMapper.builder().build();
    private static final Path STORE_DIR = makeKeyStore();

    // The PDF contract signs, so the signer's bundle needs a keystore; the application's default
    // (./local/dev-signer.p12) is a gitignored developer file, absent on a fresh checkout.
    @DynamicPropertySource
    static void keyStore(DynamicPropertyRegistry registry) {
        registry.add("spring.ssl.bundle.jks.pdf-signer.keystore.location", () -> "file:" + STORE_DIR.resolve("dev-signer.p12"));
        registry.add("spring.ssl.bundle.jks.pdf-signer.keystore.password", () -> "changeit");
    }

    /** Runs scripts/make-dev-keystore.sh with this JDK's keytool into a fresh directory. */
    private static Path makeKeyStore() {
        try {
            Path dir = Files.createTempDirectory("datum-example-pdf-bindings");
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
        return DatumTck.localBuilder(port).pdfBindings(true).build();
    }

    @Test
    void hostJsonPublishesTheTableTheGlueReads() throws Exception {
        HttpResponse<byte[]> reply = HttpClient.newHttpClient().send(
            HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/datum/assets/host.json")).GET().build(), HttpResponse.BodyHandlers.ofByteArray());
        assertThat(reply.statusCode()).isEqualTo(200);
        JsonNode bindings = JSON.readTree(reply.body()).path("bindings");
        assertThat(bindings.path("default").asString()).isEqualTo("datum");
        assertThat(bindings.path("routes").path(TckFixtures.FORM_B).asString()).isEqualTo("ledger-binding");
        assertThat(bindings.path("catalog").toString()).contains("{\"id\":\"datum\",\"label\":\"Datum\",\"pdfTheme\":\"datum-pdf\"}",
            "{\"id\":\"ledger-binding\",\"label\":\"Ledger\",\"pdfTheme\":\"" + TckFixtures.PDF_THEME_ID + "\"}");
        assertThat(new String(reply.body(), StandardCharsets.UTF_8)).doesNotContain("123456");
    }
}
