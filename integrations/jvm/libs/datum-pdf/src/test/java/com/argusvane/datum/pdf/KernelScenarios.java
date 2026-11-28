package com.argusvane.datum.pdf;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import com.argusvane.datum.sandbox.protocol.AbiProbe;
import com.argusvane.datum.sandbox.protocol.HostOptions;
import com.argusvane.datum.sandbox.protocol.PdfAbi;
import com.argusvane.datum.sandbox.protocol.PdfProgram;
import com.argusvane.datum.sandbox.protocol.Program;
import com.argusvane.datum.sandbox.protocol.ProgramRunner;
import com.argusvane.datum.sandbox.protocol.ProgramLimits;
import com.argusvane.datum.sandbox.wasi.GuestRuntime;
import com.argusvane.datum.sandbox.protocol.RunSlots;
import com.argusvane.datum.pdf.verify.PdfTrust;
import com.argusvane.datum.pdf.verify.PdfVerification;
import com.argusvane.datum.pdf.verify.SignatureVerdict;
import com.argusvane.datum.pdf.verify.TimestampVerdict;
import com.argusvane.datum.timestamp.InMemoryTsaLog;
import com.argusvane.datum.timestamp.TimestampAuthority;
import com.argusvane.datum.timestamp.Timestamper;
import com.argusvane.datum.timestamp.TsaKeyMaterial;
import java.nio.charset.StandardCharsets;
import java.security.cert.X509Certificate;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * The service over the real PDF program: the documents-3.8 parity hashes for the fixed env, and the
 * seal end to end: render, sign with the server's key, timestamp with datum-timestamp's Java authority, complete,
 * verify, with the kernel's own answers ({@code timestamped}, {@code coversSignature}, {@code certificateMatches}) and
 * the host's verdicts. A subclass names the runtime.
 */
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
abstract class KernelScenarios {

    private static final String FORM = "{\"id\":\"permit\",\"version\":\"1\",\"root\":{\"id\":\"root\",\"type\":\"form\",\"configuration\":"
        + "{\"title\":\"Permit\"},\"children\":{\"content\":[{\"id\":\"name\",\"type\":\"text\",\"configuration\":{\"label\":\"Name\"}},"
        + "{\"id\":\"city\",\"type\":\"text\",\"configuration\":{\"label\":\"City\"}}]}}}";

    private GuestRuntime engine;
    private Program program;
    private PdfRuntime runtime;
    private final List<String> times = new ArrayList<>();

    /** The runtime under test, or a skip (an assumption) when it is not here. */
    abstract GuestRuntime engine();

    @BeforeAll
    void start() {
        program = TestAssets.pdfProgram();
        assumeTrue(program != null, "datum-programs holds no PDF program: run npm run jvm:assets");
        engine = engine();
        // A parity and flow test, not a speed test: 60 s per run, as datum-sandbox-endive's PdfRenderIT.
        ProgramLimits limits = ProgramLimits.builder().pdfSeconds(60).build();
        PdfProgram pdf = new PdfProgram(ProgramRunner.on(engine), program, limits, new AbiProbe());
        runtime = PdfRuntime.of(pdf, new RunSlots(2, Duration.ofSeconds(10), "PDF render"), engine.engineInfo(), HostOptions.defaults(), limits);
    }

    @AfterAll
    void stop() throws Exception {
        if (engine instanceof AutoCloseable closeable) {
            closeable.close();
        }
        if (!times.isEmpty()) {
            System.out.printf("[datum-pdf] %s on Java %d: %s%n", getClass().getSimpleName(), Runtime.version().feature(), String.join(", ", times));
        }
    }

    private static ObjectNode definition() {
        return (ObjectNode) TestAssets.JSON.readTree(FORM);
    }

    private static ObjectNode values() {
        return (ObjectNode) TestAssets.JSON.readTree("{\"name\":\"Ada Lovelace\",\"city\":\"Ottawa\"}");
    }

    private static TimestampAuthority authority() {
        return new TimestampAuthority(TsaKeyMaterial.of(TestAssets.identity("tsa")), null, null, Clock.systemUTC(), new InMemoryTsaLog(Clock.systemUTC()));
    }

    @Test
    void theProgramProvesItsAbiAndCanSign() {
        PdfService pdf = PdfService.builder().runtime(runtime).build();
        assertThat(pdf.capabilities().abi()).isEqualTo(PdfAbi.MIN);
        assertThat(pdf.capabilities().kernelVersion()).isNotEmpty();
    }

    @Test
    void theParityDocumentsRenderToTheirPinnedHashesThroughTheService() {
        // The fixed env of kernel-compat.test.ts; the producer through a customizer (the service's env carries none).
        PdfRequestCustomizer producer = draft -> {
            ObjectNode env = (ObjectNode) draft.env().deepCopy();
            env.put("producer", "Datum pdf-theme-sheet");
            draft.env(env);
        };
        PdfService pdf = PdfService.builder().runtime(runtime).customizers(List.of(producer)).build();
        PdfOptions options = PdfOptions.defaults().withFonts(PdfFonts.Pack.ALL)
            .withDocument("pdf-theme-sheet", Instant.parse("2026-09-05T10:11:12Z"));
        JsonNode hashes = TestAssets.kernelJson("documents-3.8/hashes.json");
        for (Map.Entry<String, JsonNode> entry : hashes.properties()) {
            long started = System.nanoTime();
            PdfResult result = pdf.render(TestAssets.kernelJson("documents-3.8/" + entry.getKey() + ".json"), options);
            times.add(String.format("%s %.0f ms", entry.getKey(), (System.nanoTime() - started) / 1e6));
            assertThat(PdfService.sha256(result.bytes())).as(entry.getKey()).isEqualTo(entry.getValue().asString());
        }
    }

    @Test
    void aSealWithAJavaTimestampVerifiesAsTheServersAndTimestamped() {
        KeyStorePdfSigner signer = TestAssets.signer("rsa2048");
        X509Certificate tsa = TestAssets.certificate("tsa");
        PdfTrust trust = new PdfTrust(List::of, List.of(), List.of(), () -> List.of(tsa), Clock.systemUTC());
        List<PdfRenderedEvent> events = new ArrayList<>();
        PdfService pdf = PdfService.builder().runtime(runtime).signer(signer).seal(SealPreset.on()).timestamper(authority(), "site").trust(trust)
            .events(event -> {
            if (event instanceof PdfRenderedEvent rendered) {
                events.add(rendered);
            }
        }).build();
        long started = System.nanoTime();
        PdfResult sealed = pdf.renderSubmission(definition(), values(), "en", null, PdfOptions.defaults().withFormKey("permit")
            .withDocument("6f1c2c1e-5b1a-4a49-9a76-3b3c1f7e2d10", Instant.parse("2026-10-15T12:00:00Z")));
        times.add(String.format("seal %.0f ms", (System.nanoTime() - started) / 1e6));
        assertThat(sealed.seal()).isNotNull();
        assertThat(sealed.seal().timestamped()).as(String.valueOf(sealed.warnings())).isTrue();
        assertThat(sealed.layoutId()).isEqualTo("default");
        assertThat(new String(sealed.bytes(), 0, 5, StandardCharsets.US_ASCII)).isEqualTo("%PDF-");
        assertThat(events).hasSize(1);
        assertThat(events.get(0).signed()).isTrue();
        assertThat(events.get(0).timestamped()).isTrue();

        // The kernel's own reading.
        ObjectNode raw = pdf.verifyRaw(sealed.bytes());
        JsonNode report = raw.path("signatures").get(0);
        assertThat(report.path("digestMatches").asBoolean()).isTrue();
        assertThat(report.path("certificateMatches").asBoolean()).isTrue();
        assertThat(report.path("coversDocument").asBoolean()).isTrue();
        assertThat(report.path("certification").path("permissions").asString()).isEqualTo("noChanges");
        assertThat(report.path("timestamp").path("coversSignature").asBoolean()).isTrue();
        assertThat(report.path("timestamp").path("certificateMatches").asBoolean()).isTrue();
        assertThat(report.path("timestamp").path("messageDigestMatches").asBoolean()).isTrue();
        assertThat(report.path("timestamp").path("contentTypeMatches").asBoolean()).isTrue();

        // The host's verdict.
        PdfVerification verification = pdf.verify(sealed.bytes());
        assertThat(verification.signatures()).hasSize(1);
        SignatureVerdict signature = verification.signatures().get(0);
        assertThat(signature.value()).isEqualTo("valid");
        assertThat(signature.intact()).isTrue();
        assertThat(signature.trust()).isEqualTo("site");
        assertThat(signature.certification()).isEqualTo("noChanges");
        assertThat(signature.certificationState()).isEqualTo("kept");
        assertThat(signature.signingTime()).isEqualTo("2026-10-15T12:00:00Z");
        TimestampVerdict timestamp = signature.timestamp();
        assertThat(timestamp.coversSignature()).isTrue();
        assertThat(timestamp.verified()).as(String.valueOf(timestamp)).isTrue();
        assertThat(timestamp.trust()).isEqualTo("site");
        assertThat(timestamp.problem()).isNull();
        // The document key the seal signed: the first 16 bytes of SHA-256 over env.documentId.
        assertThat(verification.documentIdSource()).isEqualTo("signed");
        assertThat(verification.documentId())
            .isEqualTo(PdfService.sha256("6f1c2c1e-5b1a-4a49-9a76-3b3c1f7e2d10".getBytes(StandardCharsets.UTF_8)).substring(0, 32));

        // One byte changed inside the signed range (the header's binary comment): the digest no longer holds.
        byte[] tampered = sealed.bytes();
        int at = indexOf(tampered, "\n%".getBytes(StandardCharsets.US_ASCII), 5);
        assertThat(at).isPositive();
        tampered[at + 2] ^= 0x01;
        SignatureVerdict broken = pdf.verify(tampered).signatures().get(0);
        assertThat(broken.digestMatches()).isFalse();
        assertThat(broken.intact()).isFalse();
    }

    @Test
    void anEcdsaSealCertifiedForFormFillingVerifies() {
        KeyStorePdfSigner signer = TestAssets.signer("p256");
        PdfService pdf = PdfService.builder().runtime(runtime).signer(signer)
            .seal(SealPreset.on().withCertify(SealPreset.Certify.FORM_FILL).withTimestamp(false)).build();
        PdfResult sealed = pdf.renderSubmission(definition(), values(), "en", null, PdfOptions.defaults());
        assertThat(sealed.seal().timestamped()).isFalse();
        SignatureVerdict signature = pdf.verify(sealed.bytes()).signatures().get(0);
        assertThat(signature.value()).isEqualTo("valid");
        assertThat(signature.intact()).isTrue();
        assertThat(signature.certification()).isEqualTo("formFilling");
        assertThat(signature.timestamp()).isNull();
        // Something appended after the seal: still intact where signed, not whole, and a comment is no revision.
        byte[] appended = (new String(sealed.bytes(), StandardCharsets.ISO_8859_1) + "\n% appended\n").getBytes(StandardCharsets.ISO_8859_1);
        SignatureVerdict later = pdf.verify(appended).signatures().get(0);
        assertThat(later.digestMatches()).isTrue();
        assertThat(later.coversDocument()).isFalse();
        assertThat(later.certificationState()).as(String.valueOf(later.laterRevisions())).isEqualTo("allowed");
    }

    @Test
    void aTokenTheProgramRefusesCostsTheTimestampNotTheSeal() {
        TimestampAuthority authority = authority();
        Timestamper wrong = (data, channel) -> authority.stamp("another value".getBytes(StandardCharsets.US_ASCII), channel);
        PdfService pdf = PdfService.builder().runtime(runtime).signer(TestAssets.signer("chain-leaf")).seal(SealPreset.on()).timestamper(wrong, "site")
            .build();
        PdfResult sealed = pdf.renderSubmission(definition(), values(), "en", null, PdfOptions.defaults());
        assertThat(sealed.seal()).isNotNull();
        assertThat(sealed.seal().timestamped()).isFalse();
        assertThat(sealed.warnings()).anySatisfy(w -> {
            assertThat(w.path("code").asString()).isEqualTo("sealing.timestamp");
            assertThat(w.path("message").asString()).startsWith("The timestamp server’s token was refused: ");
        });
        PdfService anchored = PdfService.builder().runtime(runtime)
            .trust(new PdfTrust(List::of, List.of(), List.of(TestAssets.certificate("demo-ca")), List::of, Clock.systemUTC())).build();
        SignatureVerdict signature = anchored.verify(sealed.bytes()).signatures().get(0);
        assertThat(signature.intact()).isTrue();
        assertThat(signature.trust()).isEqualTo("trusted");
        assertThat(signature.timestamp()).isNull();
    }

    @Test
    void aBlankCommitmentStatementSealsAndATestSealIsSelfSignedOnTheRealProgram() {
        // The program keeps a statement of one space in the signed attributes: complete must be given it back as is.
        KeyStorePdfSigner signer = TestAssets.signer("rsa2048");
        PdfService pdf = PdfService.builder().runtime(runtime).signer(signer).build();
        byte[] plain = pdf.renderSubmission(definition(), values(), "en", null, PdfOptions.defaults()).bytes();
        ObjectNode settings = (ObjectNode) TestAssets.JSON.readTree("{\"commitment\":{\"type\":\"approval\",\"statement\":\" \"}}");
        PdfResult sealed = pdf.signWithServerKey(plain, settings, PdfOptions.defaults());
        assertThat(sealed.signed()).isTrue();
        SignatureVerdict signature = pdf.verify(sealed.bytes()).signatures().get(0);
        assertThat(signature.intact()).isTrue();
        assertThat(signature.trust()).isEqualTo("site");
        assertThat(signature.commitment().type()).isEqualTo("approval");

        // Answers never submitted: the throwaway certificate, which nothing trusts and which is not the server's.
        PdfService preset = PdfService.builder().runtime(runtime).signer(signer).seal(SealPreset.on()).build();
        PdfResult test = preset.renderSubmission(definition(), values(), "en", null, PdfOptions.defaults(), PdfService.SealMode.TEST);
        assertThat(test.seal().test()).isTrue();
        assertThat(test.signed()).isFalse();
        SignatureVerdict throwaway = preset.verify(test.bytes()).signatures().get(0);
        assertThat(throwaway.value()).isEqualTo("valid");
        assertThat(throwaway.intact()).isTrue();
        assertThat(throwaway.trust()).isEqualTo("self_signed");
        assertThat(throwaway.signer().commonName()).isEqualTo(TestSeal.COMMON_NAME);
        assertThat(throwaway.reason()).isEqualTo(TestSeal.REASON);
        assertThat(throwaway.timestamp()).isNull();
    }

    private static int indexOf(byte[] haystack, byte[] needle, int from) {
        outer:
        for (int i = from; i <= haystack.length - needle.length; i++) {
            for (int j = 0; j < needle.length; j++) {
                if (haystack[i + j] != needle[j]) {
                    continue outer;
                }
            }
            return i;
        }
        return -1;
    }
}
