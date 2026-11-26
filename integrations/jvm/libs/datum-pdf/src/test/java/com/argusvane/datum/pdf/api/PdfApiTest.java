package com.argusvane.datum.pdf.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.core.DatumException;
import com.argusvane.datum.core.RequestTooLargeException;
import com.argusvane.datum.pdf.PdfException;
import com.argusvane.datum.pdf.PdfResult;
import com.argusvane.datum.pdf.PdfService;
import com.argusvane.datum.pdf.PdfUnavailableException;
import com.argusvane.datum.pdf.ScriptedPdfRuntime;
import com.argusvane.datum.pdf.SealPreset;
import com.argusvane.datum.pdf.TestAssets;
import com.argusvane.datum.pdf.TestSeal;
import com.argusvane.datum.submissions.receiver.ReceiverAnswer;
import com.argusvane.datum.submissions.receiver.SubmissionRejectedException;
import com.argusvane.datum.submissions.receiver.ThrottledException;
import com.argusvane.datum.submissions.spi.SubmissionError;
import com.argusvane.datum.submissions.spi.SubmissionRequest;
import com.argusvane.datum.submissions.spi.SubmissionThrottle;
import com.argusvane.datum.submissions.spi.ThrottleDecision;
import com.argusvane.datum.submissions.spi.ThrottleKey;
import com.argusvane.datum.web.error.BadRequestException;
import com.argusvane.datum.web.error.UnsupportedMediaTypeException;
import com.argusvane.datum.web.json.DatumJsonMapper;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * The PDF endpoints' decisions, framework-free ({@link PdfApi}): the order of the refusals, the dry run before the
 * render, what is sealed, the replies' headers. The adapters only move bytes.
 */
class PdfApiTest {

    static final String DEFINITION = "{\"id\":\"intake\",\"version\":\"3\",\"root\":{\"id\":\"root\",\"type\":\"form\",\"configuration\":{},"
        + "\"children\":{\"content\":[]}},\"pdf\":{\"layouts\":[{\"id\":\"copy\",\"kind\":\"generated\"},{\"id\":\"form-a\",\"kind\":\"template\"}]}}";

    static final String ENVELOPE = "{\"versionContext\":{\"form\":{\"id\":\"intake\",\"version\":\"3\"}},\"submission\":{\"values\":{\"name\":\"<b>x</b>\"},"
        + "\"locale\":\"fr\"}}";

    static SubmissionRequest json() {
        return new SubmissionRequest("application/json", Map.of(), "192.0.2.7", null);
    }

    static byte[] body(String json) {
        return json.getBytes(StandardCharsets.UTF_8);
    }

    /** Accepts every document, with these sanitized values; records the bodies it was asked about. */
    static final class Accepting implements AnswerCheck {
        final List<JsonNode> asked = new ArrayList<>();

        @Override
        public CheckedAnswers check(SubmissionRequest request, byte[] body) {
            asked.add(TestAssets.JSON.readTree(body));
            return new CheckedAnswers(true, null, List.of(), (ObjectNode) TestAssets.JSON.readTree("{\"name\":\"x\"}"));
        }
    }

    static PdfApi.Builder api(PdfService pdf, AnswerCheck check) {
        return PdfApi.builder().pdf(pdf).check(check).definitions(key -> (ObjectNode) TestAssets.JSON.readTree(DEFINITION))
            .json(DatumJsonMapper.create(1024 * 1024)).maxBodyBytes(64 * 1024);
    }

    @Test
    void pdfJudgesTheAnswersThenPrintsTheSanitizedValues() {
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
        Accepting check = new Accepting();
        PdfApi api = api(PdfService.builder().runtime(runtime.pdfRuntime()).build(), check).build();
        PdfReply reply = api.pdf(body("{\"document\":" + ENVELOPE + ",\"layoutId\":\"copy\",\"options\":{\"fonts\":\"standard\",\"tagged\":true}}"), json());
        assertThat(check.asked).hasSize(1);
        assertThat(check.asked.get(0).path("document").path("submission").path("locale").asString()).isEqualTo("fr");
        assertThat(check.asked.get(0).has("layoutId")).as("the dry run sees the document only").isFalse();
        ObjectNode sent = runtime.requests("document").get(0);
        assertThat(sent.path("values").path("name").asString()).as("the sanitized values, not the posted ones").isEqualTo("x");
        assertThat(sent.path("locale").asString()).isEqualTo("fr");
        assertThat(sent.path("layoutId").asString()).isEqualTo("copy");
        assertThat(sent.path("fonts")).hasSize(5);
        assertThat(sent.path("options").path("tagged").asBoolean()).isTrue();
        assertThat(reply.status()).isEqualTo(200);
        assertThat(reply.contentType()).isEqualTo("application/pdf");
        assertThat(reply.headers()).containsEntry("X-Page-Count", "1").containsEntry("X-Datum-Layout", "copy")
            .containsEntry("Content-Disposition", "attachment; filename=\"intake-copy.pdf\"").containsEntry("Cache-Control", "no-store")
            .doesNotContainKey("X-Signed-By");
        assertThat(new String(reply.body(), StandardCharsets.US_ASCII)).startsWith("%PDF-");
    }

    /**
     * The print is drawn under the server's host context: the application's provider, asked with the request's
     * facts for the form the document names, never a context the body carries; none without a provider or when it
     * supplies none; a provider that fails refuses the print with 503 server.unavailable before any render.
     */
    @Test
    void thePrintCarriesTheServersHostContextNeverTheBodys() {
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
        List<com.argusvane.datum.submissions.spi.HostContextRequest> asked = new ArrayList<>();
        SubmissionRequest admin = new SubmissionRequest("application/json", Map.of("X-Role", List.of("admin")), "192.0.2.7", null);
        String forged = "{\"document\":{\"versionContext\":{\"form\":{\"id\":\"intake\",\"version\":\"3\"}},\"hostContext\":{\"role\":\"x\"},"
            + "\"submission\":{\"values\":{\"name\":\"x\"},\"locale\":\"fr\"}}}";
        PdfApi api = api(PdfService.builder().runtime(runtime.pdfRuntime()).build(), new Accepting())
            .hostContext(request -> {
                asked.add(request);
                return java.util.Optional.of(Map.of("role", String.valueOf(request.submission().header("X-Role"))));
            }).build();
        api.pdf(body(forged), admin);
        assertThat(runtime.requests("document").get(0).path("hostContext").toString()).isEqualTo("{\"role\":\"admin\"}");
        assertThat(asked).singleElement().satisfies(request -> {
            assertThat(request.formKey()).isEqualTo("intake");
            assertThat(request.formVersion()).isEqualTo("3");
            assertThat(request.mode()).isEqualTo(com.argusvane.datum.submissions.spi.SubmissionMode.PDF);
        });

        ScriptedPdfRuntime none = new ScriptedPdfRuntime();
        api(PdfService.builder().runtime(none.pdfRuntime()).build(), new Accepting()).build().pdf(body(forged), admin);
        assertThat(none.requests("document").get(0).has("hostContext")).as("no provider: no context").isFalse();

        ScriptedPdfRuntime broken = new ScriptedPdfRuntime();
        PdfApi failing = api(PdfService.builder().runtime(broken.pdfRuntime()).build(), new Accepting())
            .hostContext(request -> {
                throw new IllegalStateException("down");
            }).build();
        assertThatThrownBy(() -> failing.pdf(body(forged), admin))
            .isInstanceOfSatisfying(DatumException.class, e -> {
                assertThat(e.code()).isEqualTo("server.unavailable");
                assertThat(e.httpStatus()).isEqualTo(503);
            });
        assertThat(broken.requests("document")).isEmpty();
    }

    @Test
    void theReplyNamesThePdfThemeTheFormsBindingSuggestsAndTheRequestCarriesItsObject() {
        com.argusvane.datum.core.assets.AssetManifest manifest = new com.argusvane.datum.core.assets.AssetManifest("b1", null, "0.1.0", null,
            null, null, List.of(new com.argusvane.datum.core.assets.AssetManifest.Binding("datum", "Datum", "datum-pdf")), null, null, null, null);
        JsonNode ledger = TestAssets.JSON.readTree("{\"id\":\"ledger\",\"version\":\"1.0.0\",\"target\":\"pdf\"}");
        // The fixture form is "intake": one route on the host's default binding, one overridden.
        for (boolean overridden : new boolean[] {false, true}) {
            ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
            com.argusvane.datum.core.assets.HostBindings bindings = com.argusvane.datum.core.assets.HostBindings.of(manifest, "datum",
                overridden ? Map.of("intake", "ledger-binding") : Map.of(),
                List.of(new com.argusvane.datum.core.assets.AssetManifest.Binding("ledger-binding", "Ledger", "ledger")), Map.of("ledger", ledger));
            PdfApi api = api(PdfService.builder().runtime(runtime.pdfRuntime()).bindings(bindings).build(), new Accepting()).build();
            PdfReply reply = api.pdf(body("{\"document\":" + ENVELOPE + "}"), json());
            assertThat(reply.headers()).containsEntry("X-Datum-Pdf-Theme", overridden ? "ledger" : "datum-pdf");
            assertThat(runtime.requests("document").get(0).path("theme").path("id").asString()).isEqualTo(overridden ? "ledger" : "");
        }
        PdfApi plain = api(PdfService.builder().runtime(new ScriptedPdfRuntime().pdfRuntime()).build(), new Accepting()).build();
        assertThat(plain.pdf(body("{\"document\":" + ENVELOPE + "}"), json()).headers()).doesNotContainKey("X-Datum-Pdf-Theme");
    }

    @Test
    void theRefusalsComeInOrder() {
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
        Accepting check = new Accepting();
        PdfApi api = api(PdfService.builder().runtime(runtime.pdfRuntime()).build(), check).build();
        SubmissionRequest text = new SubmissionRequest("text/plain", Map.of(), null, null);
        assertThatThrownBy(() -> api.pdf(body("{}"), text)).isInstanceOf(UnsupportedMediaTypeException.class);
        assertThatThrownBy(() -> api.pdf(new byte[64 * 1024 + 1], json())).isInstanceOf(RequestTooLargeException.class);
        assertThatThrownBy(() -> api.pdf(body("{not json"), json())).isInstanceOf(BadRequestException.class)
            .satisfies(e -> assertThat(((BadRequestException) e).code()).isEqualTo("bad_document"));
        assertThatThrownBy(() -> api.pdf(body("[]"), json())).isInstanceOf(BadRequestException.class);
        assertThatThrownBy(() -> api.pdf(body("{\"document\":" + ENVELOPE + ",\"ZZSECRETZZ<br />\":\"1.0.0\"}"), json()))
            .isInstanceOf(BadRequestException.class).hasMessage("The request has a member it does not take.");
        assertThatThrownBy(() -> api.pdf(body("{\"document\":" + ENVELOPE + ",\"template\":{\"data\":\"AA==\"}}"), json()))
            .as("template is fill's only").isInstanceOf(BadRequestException.class);
        assertThatThrownBy(() -> api.pdf(body("{\"document\":\"text\"}"), json())).isInstanceOf(BadRequestException.class);
        assertThatThrownBy(() -> api.pdf(body("{\"document\":" + ENVELOPE + ",\"layoutId\":7}"), json())).isInstanceOf(BadRequestException.class);
        assertThatThrownBy(() -> api.pdf(body("{\"document\":" + ENVELOPE + ",\"locale\":\"fr;x\"}"), json())).isInstanceOf(BadRequestException.class);
        assertThatThrownBy(() -> api.pdf(body("{\"document\":" + ENVELOPE + ",\"options\":{\"fonts\":\"comic\"}}"), json()))
            .isInstanceOf(BadRequestException.class);
        assertThatThrownBy(() -> api.pdf(body("{\"document\":" + ENVELOPE + ",\"options\":{\"pdfa\":true}}"), json()))
            .isInstanceOf(BadRequestException.class);
        assertThatThrownBy(() -> api.pdf(body("{\"document\":" + ENVELOPE + ",\"options\":{\"compact\":\"yes\"}}"), json()))
            .isInstanceOf(BadRequestException.class);
        assertThatThrownBy(() -> api.pdf(body("{\"document\":" + ENVELOPE + ",\"options\":{\"ZZSECRETZZ\":\"x\"}}"), json()))
            .isInstanceOf(BadRequestException.class).hasMessage("options has a member it does not take.");
        assertThat(check.asked).as("nothing was judged").isEmpty();
        assertThat(runtime.requests()).isEmpty();

        // A fill without its layout is the shape's 400, before the throttle (and any run).
        assertThatThrownBy(() -> api.fill(body("{\"document\":" + ENVELOPE + "}"), json())).isInstanceOf(BadRequestException.class)
            .hasMessageContaining("layoutId");
        assertThat(check.asked).isEmpty();
    }

    @Test
    void aServerThatCannotPrintAnswers503BeforeTheDryRun() {
        Accepting check = new Accepting();
        PdfService bytecode = PdfService.builder().runtime(new ScriptedPdfRuntime().pdfRuntime("bytecode", 1)).build();
        PdfApi api = api(bytecode, check).build();
        assertThatThrownBy(() -> api.pdf(body("{\"document\":" + ENVELOPE + "}"), json())).isInstanceOf(PdfUnavailableException.class);
        assertThatThrownBy(() -> api.fill(body("{\"document\":" + ENVELOPE + ",\"layoutId\":\"form-a\"}"), json()))
            .isInstanceOf(PdfUnavailableException.class);
        assertThat(check.asked).as("no sandbox run spent").isEmpty();
    }

    @Test
    void theThrottleCountsKindPdfBeforeTheDryRun() {
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
        Accepting check = new Accepting();
        AtomicReference<ThrottleKey> seen = new AtomicReference<>();
        List<ThrottleKey> recorded = new ArrayList<>();
        SubmissionThrottle throttle = new SubmissionThrottle() {
            @Override
            public ThrottleDecision check(ThrottleKey key) {
                seen.set(key);
                return recorded.isEmpty() ? ThrottleDecision.ALLOW : new ThrottleDecision.Deny(Duration.ofSeconds(30));
            }

            @Override
            public void record(ThrottleKey key) {
                recorded.add(key);
            }
        };
        PdfApi api = api(PdfService.builder().runtime(runtime.pdfRuntime()).build(), check).throttle(throttle).build();
        api.pdf(body("{\"document\":" + ENVELOPE + "}"), json());
        assertThat(seen.get().kind()).isEqualTo(ThrottleKey.Kind.PDF);
        assertThat(seen.get().formKey()).isEqualTo("intake");
        assertThat(seen.get().ip()).isEqualTo("192.0.2.7");
        assertThatThrownBy(() -> api.pdf(body("{\"document\":" + ENVELOPE + "}"), json())).isInstanceOf(ThrottledException.class)
            .satisfies(e -> assertThat(((ThrottledException) e).retryAfterSeconds()).isEqualTo(30));
        assertThat(check.asked).hasSize(1);
    }

    /**
     * The address limit, which an adapter asks before it reads the body: 415 first, then the address as the throttle
     * counts it (an IPv6 client by its /64), and a refusal is the per-form refusal's 429 flood with Retry-After.
     */
    @Test
    void theAddressLimitComesAfterTheContentTypeAndBeforeTheBody() {
        List<String> counted = new ArrayList<>();
        AtomicReference<Duration> closed = new AtomicReference<>();
        SubmissionThrottle throttle = new SubmissionThrottle() {
            @Override
            public ThrottleDecision check(ThrottleKey key) {
                return ThrottleDecision.ALLOW;
            }

            @Override
            public void record(ThrottleKey key) {
            }

            @Override
            public ThrottleDecision checkAddress(String address) {
                return closed.get() == null ? ThrottleDecision.ALLOW : new ThrottleDecision.Deny(closed.get());
            }

            @Override
            public void recordAddress(String address) {
                counted.add(address);
            }
        };
        PdfApi api = api(PdfService.builder().runtime(new ScriptedPdfRuntime().pdfRuntime()).build(), new Accepting()).throttle(throttle).build();
        assertThatThrownBy(() -> api.admitJson(new SubmissionRequest("text/plain", Map.of(), "192.0.2.7", null)))
            .isInstanceOf(com.argusvane.datum.web.error.UnsupportedMediaTypeException.class);
        assertThatThrownBy(() -> api.admitPdf(new SubmissionRequest("application/json", Map.of(), "192.0.2.7", null)))
            .isInstanceOf(com.argusvane.datum.web.error.UnsupportedMediaTypeException.class);
        assertThat(counted).isEmpty();
        api.admitJson(new SubmissionRequest("application/json", Map.of(), "2001:db8:1:2::abcd", null));
        api.admitPdf(new SubmissionRequest("application/pdf", Map.of(), "192.0.2.7", null));
        api.admitJson(new SubmissionRequest("application/json", Map.of(), null, null));
        assertThat(counted).as("no address, no count").containsExactly("2001:db8:1:2::/64", "192.0.2.7");
        closed.set(Duration.ofSeconds(12));
        assertThatThrownBy(() -> api.admitJson(json())).isInstanceOf(ThrottledException.class)
            .satisfies(e -> {
                assertThat(((ThrottledException) e).code()).isEqualTo("flood");
                assertThat(((ThrottledException) e).responseHeaders()).containsEntry("Retry-After", "12");
            });
        assertThat(counted).hasSize(2);
    }

    /** Two addresses of one IPv6 /64 share one window (the key names the /64); another /64 has its own. */
    @Test
    void theThrottleCountsAnIpv6ClientByItsSlash64() {
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
        List<ThrottleKey> recorded = new ArrayList<>();
        SubmissionThrottle oncePerKey = new SubmissionThrottle() {
            @Override
            public ThrottleDecision check(ThrottleKey key) {
                return recorded.contains(key) ? new ThrottleDecision.Deny(Duration.ofSeconds(30)) : ThrottleDecision.ALLOW;
            }

            @Override
            public void record(ThrottleKey key) {
                recorded.add(key);
            }
        };
        PdfApi api = api(PdfService.builder().runtime(runtime.pdfRuntime()).build(), new Accepting()).throttle(oncePerKey).build();
        api.pdf(body("{\"document\":" + ENVELOPE + "}"), new SubmissionRequest("application/json", Map.of(), "2001:db8:1:2::abcd", null));
        assertThat(recorded).singleElement().satisfies(key -> assertThat(key.ip()).isEqualTo("2001:db8:1:2::/64"));
        assertThatThrownBy(() -> api.pdf(body("{\"document\":" + ENVELOPE + "}"),
            new SubmissionRequest("application/json", Map.of(), "2001:db8:1:2::1", null))).isInstanceOf(ThrottledException.class);
        api.pdf(body("{\"document\":" + ENVELOPE + "}"), new SubmissionRequest("application/json", Map.of(), "2001:db8:1:3::1", null));
        assertThat(recorded).extracting(ThrottleKey::ip).containsExactly("2001:db8:1:2::/64", "2001:db8:1:3::/64");
    }

    @Test
    void answersTheServerDoesNotAcceptAreRefusedWithTheirFindingsAndNotPrinted() {
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
        AnswerCheck refusing = (request, body) -> new CheckedAnswers(false, "sandbox",
            List.of(SubmissionError.error("name", "required", null), SubmissionError.warning("email", "format.hint", null)), null);
        PdfApi api = api(PdfService.builder().runtime(runtime.pdfRuntime()).build(), refusing).build();
        assertThatThrownBy(() -> api.pdf(body("{\"document\":" + ENVELOPE + "}"), json())).isInstanceOf(SubmissionRejectedException.class)
            .satisfies(e -> {
                SubmissionRejectedException rejected = (SubmissionRejectedException) e;
                assertThat(rejected.httpStatus()).isEqualTo(422);
                assertThat(rejected.stage()).isEqualTo("sandbox");
                assertThat(rejected.errors()).extracting(SubmissionError::code).containsExactly("required", "format.hint");
            });
        assertThat(runtime.requests()).isEmpty();
    }

    @Test
    void theReceiversRefusalsPassThrough() {
        AnswerCheck notFound = (request, body) -> {
            throw new DatumException("form.notFound", 404, "There is no such form.");
        };
        PdfApi api = api(PdfService.builder().runtime(new ScriptedPdfRuntime().pdfRuntime()).build(), notFound).build();
        assertThatThrownBy(() -> api.pdf(body("{\"document\":{\"versionContext\":{\"form\":{\"id\":\"../x\"}}}}"), json()))
            .isInstanceOf(DatumException.class).satisfies(e -> assertThat(((DatumException) e).httpStatus()).isEqualTo(404));
    }

    @Test
    void aSignedWrapperNamesItsFormThroughItsPayload() {
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
        Accepting check = new Accepting();
        List<String> keys = new ArrayList<>();
        PdfApi api = api(PdfService.builder().runtime(runtime.pdfRuntime()).build(), check)
            .definitions(key -> {
                keys.add(key);
                return (ObjectNode) TestAssets.JSON.readTree(DEFINITION);
            }).build();
        api.pdf(body("{\"document\":{\"format\":\"datum.signed/1\",\"payload\":" + ENVELOPE + ",\"signatures\":[]}}"), json());
        assertThat(keys).containsExactly("intake");
        assertThat(runtime.requests("document").get(0).path("locale").asString()).isEqualTo("fr");
    }

    @Test
    void postedAnswersAreSealedWithAThrowawayCertificateUnlessTheApplicationSaysOtherwise() {
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
        PdfService pdf = PdfService.builder().runtime(runtime.pdfRuntime()).signer(TestAssets.signer("chain-leaf")).seal(SealPreset.on()).build();
        PdfReply test = api(pdf, new Accepting()).build().pdf(body("{\"document\":" + ENVELOPE + "}"), json());
        assertThat(test.headers()).containsEntry("X-Signed-By", "CN=" + TestSeal.COMMON_NAME).containsEntry("X-Timestamped", "false");
        assertThat(runtime.requests("document").get(0).path("signature").path("certificates").get(0).asString())
            .isNotEqualTo(TestAssets.signer("chain-leaf").certificatesBase64().get(0));
        assertThat(runtime.requests("document").get(0).path("signature").path("reason").asString()).isEqualTo(TestSeal.REASON);
        PdfReply signed = api(pdf, new Accepting()).build().sign(body("{\"document\":" + ENVELOPE + "}"), json());
        assertThat(signed.headers()).containsEntry("X-Signed-By", "CN=" + TestSeal.COMMON_NAME);
    }

    @Test
    void theSealIsInTheHeaders() {
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
        PdfService pdf = PdfService.builder().runtime(runtime.pdfRuntime()).signer(TestAssets.signer("chain-leaf")).seal(SealPreset.on()).build();
        PdfReply reply = api(pdf, new Accepting()).serverKeySealsPostedAnswers(true).build().pdf(body("{\"document\":" + ENVELOPE + "}"), json());
        assertThat(reply.headers()).containsEntry("X-Signed-By", "C=CA, O=Datum, CN=Datum forms office").containsEntry("X-Signature-Field", "Signature1")
            .containsEntry("X-Timestamped", "false").containsEntry("X-Datum-Layout", "copy");
        // No key, preset on: unsealed with a note.
        PdfService keyless = PdfService.builder().runtime(new ScriptedPdfRuntime().pdfRuntime()).seal(SealPreset.on()).build();
        PdfReply note = api(keyless, new Accepting()).build().pdf(body("{\"document\":" + ENVELOPE + "}"), json());
        assertThat(note.headers()).doesNotContainKey("X-Signed-By").containsKey("X-Datum-Seal-Note");
        assertThat(note.headers().get("X-Datum-Seal-Note")).doesNotContain(" ");
    }

    @Test
    void signAlwaysSealsAndNeedsAKeyBeforeAnythingIsJudged() {
        Accepting check = new Accepting();
        PdfService keyless = PdfService.builder().runtime(new ScriptedPdfRuntime().pdfRuntime()).build();
        assertThatThrownBy(() -> api(keyless, check).build().sign(body("{\"document\":" + ENVELOPE + "}"), json()))
            .isInstanceOf(PdfUnavailableException.class);
        assertThat(check.asked).isEmpty();
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
        PdfService pdf = PdfService.builder().runtime(runtime.pdfRuntime()).signer(TestAssets.signer("p256")).build();
        PdfReply reply = api(pdf, check).serverKeySealsPostedAnswers(true).build()
            .sign(body("{\"document\":" + ENVELOPE + ",\"layoutId\":\"copy\"}"), json());
        assertThat(reply.headers()).containsEntry("X-Signed-By", com.argusvane.datum.pdf.verify.Certificates.subject(TestAssets.signer("p256").leaf()))
            .containsEntry("Content-Disposition", "attachment; filename=\"intake-copy-signed.pdf\"");
        assertThat(runtime.count("complete")).isEqualTo(1);
    }

    @Test
    void fillTakesTheHostsTemplateFirstAndNeverSealsAPostedOne() {
        byte[] own = "%PDF-1.7 the office's form".getBytes(StandardCharsets.US_ASCII);
        byte[] posted = "%PDF-1.7 the caller's form".getBytes(StandardCharsets.US_ASCII);
        String request = "{\"document\":" + ENVELOPE + ",\"layoutId\":\"form-a\",\"template\":{\"data\":\"" + Base64.getEncoder().encodeToString(posted) + "\"}}";

        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
        PdfService pdf = PdfService.builder().runtime(runtime.pdfRuntime()).signer(TestAssets.signer("rsa2048")).seal(SealPreset.on()).build();
        PdfReply postedReply = api(pdf, new Accepting()).build().fill(body(request), json());
        assertThat(runtime.requests("document").get(0).path("template").path("data").asString()).isEqualTo(Base64.getEncoder().encodeToString(posted));
        assertThat(postedReply.headers()).doesNotContainKey("X-Signed-By").containsKey("X-Datum-Seal-Note")
            .containsEntry("Content-Disposition", "attachment; filename=\"intake-form-a-filled.pdf\"");

        ScriptedPdfRuntime second = new ScriptedPdfRuntime();
        PdfService sealed = PdfService.builder().runtime(second.pdfRuntime()).signer(TestAssets.signer("rsa2048")).seal(SealPreset.on()).build();
        List<String> asked = new ArrayList<>();
        PdfReply ownReply = api(sealed, new Accepting()).serverKeySealsPostedAnswers(true).templates((key, layout, node) -> {
            asked.add(key + "/" + layout + "/" + node.path("kind").asString());
            return own;
        }).build().fill(body(request), json());
        assertThat(asked).containsExactly("intake/form-a/template");
        assertThat(second.requests("document").get(0).path("template").path("data").asString()).isEqualTo(Base64.getEncoder().encodeToString(own));
        assertThat(ownReply.headers()).containsKey("X-Signed-By");

        PdfApi api = api(pdf, new Accepting()).build();
        assertThatThrownBy(() -> api.fill(body("{\"document\":" + ENVELOPE + "}"), json())).isInstanceOf(BadRequestException.class)
            .hasMessageContaining("layoutId");
        assertThatThrownBy(() -> api.fill(body("{\"document\":" + ENVELOPE + ",\"layoutId\":\"ZZSECRETZZ<br />\"}"), json()))
            .isInstanceOf(PdfException.class)
            .satisfies(e -> {
                assertThat(((PdfException) e).httpStatus()).isEqualTo(404);
                assertThat(e.getMessage()).doesNotContain("ZZSECRETZZ");
            });
        // A generated layout is not filled: the posted template would have sent the server's own PDF out unsealed.
        ScriptedPdfRuntime third = new ScriptedPdfRuntime();
        PdfService generated = PdfService.builder().runtime(third.pdfRuntime()).signer(TestAssets.signer("rsa2048")).seal(SealPreset.on()).build();
        String onCopy = "{\"document\":" + ENVELOPE + ",\"layoutId\":\"copy\",\"template\":{\"data\":\"" + Base64.getEncoder().encodeToString(posted) + "\"}}";
        List<String> askedOfHost = new ArrayList<>();
        assertThatThrownBy(() -> api(generated, new Accepting()).templates((key, layout, node) -> {
            askedOfHost.add(layout);
            return null;
        }).build().fill(body(onCopy), json()))
            .isInstanceOf(PdfException.class)
            .satisfies(e -> {
                assertThat(((PdfException) e).code()).isEqualTo(PdfException.LAYOUT_NOT_TEMPLATE);
                assertThat(((PdfException) e).httpStatus()).isEqualTo(400);
            });
        assertThat(askedOfHost).isEmpty();
        assertThat(third.requests()).isEmpty();
        assertThatThrownBy(() -> api.fill(body("{\"document\":" + ENVELOPE + ",\"layoutId\":\"form-a\",\"template\":{\"data\":\"%%\"}}"), json()))
            .isInstanceOf(BadRequestException.class);
    }

    @Test
    void verifyTakesAPdfAndAnswersTheReport() {
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
        List<ThrottleKey> throttled = new ArrayList<>();
        SubmissionThrottle throttle = new SubmissionThrottle() {
            @Override
            public ThrottleDecision check(ThrottleKey key) {
                return ThrottleDecision.ALLOW;
            }

            @Override
            public void record(ThrottleKey key) {
                throttled.add(key);
            }
        };
        PdfService pdf = PdfService.builder().runtime(runtime.pdfRuntime()).verifyMaxBytes(1024 * 1024).build();
        PdfApi api = api(pdf, new Accepting()).throttle(throttle).build();
        SubmissionRequest asPdf = new SubmissionRequest("application/pdf", Map.of(), "192.0.2.7", null);
        assertThatThrownBy(() -> api.verify(body("%PDF-1.7"), json())).isInstanceOf(UnsupportedMediaTypeException.class);
        assertThatThrownBy(() -> api.verify(new byte[1024 * 1024 + 1], asPdf)).isInstanceOf(RequestTooLargeException.class);
        assertThatThrownBy(() -> api.verify(body("hello"), asPdf)).isInstanceOf(PdfException.class)
            .satisfies(e -> assertThat(((PdfException) e).code()).isEqualTo("pdf.notAPdf"));
        PdfReply reply = api.verify(body("%PDF-1.7\n"), asPdf);
        assertThat(reply.contentType()).isEqualTo("application/json");
        JsonNode report = TestAssets.JSON.readTree(reply.body());
        assertThat(report.path("sha256").asString()).matches("^[0-9a-f]{64}$");
        assertThat(report.path("signatures").isArray()).isTrue();
        assertThat(report.has("documentIdSource")).isTrue();
        assertThat(throttled).extracting(ThrottleKey::kind).containsOnly(ThrottleKey.Kind.PDF);
        assertThat(api.maxPdfBytes()).isEqualTo(1024 * 1024);
    }

    @Test
    void theCertificateIsTheSignersChainAsPem() {
        PdfService keyless = PdfService.builder().runtime(new ScriptedPdfRuntime().pdfRuntime()).build();
        assertThatThrownBy(() -> api(keyless, new Accepting()).build().certificate(json())).isInstanceOf(DatumException.class)
            .satisfies(e -> {
                assertThat(((DatumException) e).httpStatus()).isEqualTo(404);
                assertThat(((DatumException) e).code()).isEqualTo("certificate.notFound");
            });
        PdfService pdf = PdfService.builder().runtime(new ScriptedPdfRuntime().pdfRuntime()).signer(TestAssets.signer("chain-leaf")).build();
        PdfReply reply = api(pdf, new Accepting()).build().certificate(json());
        String pem = new String(reply.body(), StandardCharsets.US_ASCII);
        assertThat(reply.contentType()).isEqualTo("application/x-pem-file");
        assertThat(pem.split("-----BEGIN CERTIFICATE-----", -1)).hasSize(3);
        assertThat(com.argusvane.datum.timestamp.PemCertificates.read(pem)).hasSize(2);
    }

    @Test
    void theDryRunsReportIsRead() {
        ObjectNode report = (ObjectNode) TestAssets.JSON.readTree("{\"outcome\":\"accepted\",\"stage\":null,\"errors\":[{\"field\":\"email\","
            + "\"code\":\"format.hint\",\"message\":null,\"severity\":\"warning\",\"stage\":\"sandbox\",\"source\":null}],\"values\":{\"name\":\"x\"}}");
        CheckedAnswers accepted = AnswerCheck.read(new ReceiverAnswer(200, report));
        assertThat(accepted.accepted()).isTrue();
        assertThat(accepted.values().path("name").asString()).isEqualTo("x");
        assertThat(accepted.errors()).hasSize(1);
        assertThat(accepted.errors().get(0).severity()).isEqualTo("warning");
        report.put("outcome", "rejected");
        report.put("stage", "journey");
        CheckedAnswers rejected = AnswerCheck.read(new ReceiverAnswer(200, report));
        assertThat(rejected.accepted()).isFalse();
        assertThat(rejected.values()).isNull();
        assertThat(rejected.stage()).isEqualTo("journey");
        report.put("outcome", "accepted");
        report.putNull("values");
        assertThat(AnswerCheck.read(new ReceiverAnswer(200, report)).accepted()).as("accepted with no values is not printable").isFalse();
    }

    @Test
    void theLayoutHeaderIsPrintableAsciiWhateverTheDefinitionNamedIt() {
        PdfResult result = new PdfResult("%PDF-1.7".getBytes(StandardCharsets.US_ASCII), 1, "résumé\r\nX-Evil: 1", "generated", null, List.of(), 1,
            null, null, TestAssets.JSON.createObjectNode());
        PdfReply reply = PdfApi.pdfReply(result, "intake", null, "");
        assertThat(reply.headers().get("X-Datum-Layout")).isEqualTo("r%C3%A9sum%C3%A9%0D%0AX-Evil: 1");
        assertThat(reply.headers().values()).allSatisfy(v -> assertThat(v).matches("^[\\x20-\\x7e]*$"));
    }

    @Test
    void verifyAnswersTheCallers400ForAFileTheProgramRefuses() {
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime()
            .on("verify", body -> ScriptedPdfRuntime.failure("signature", "An encrypted document's signatures cannot be read"));
        PdfApi api = api(PdfService.builder().runtime(runtime.pdfRuntime()).build(), new Accepting()).build();
        SubmissionRequest asPdf = new SubmissionRequest("application/pdf", Map.of(), "192.0.2.7", null);
        assertThatThrownBy(() -> api.verify(body("%PDF-1.7 encrypted"), asPdf)).isInstanceOf(PdfException.class)
            .satisfies(e -> {
                assertThat(((PdfException) e).httpStatus()).isEqualTo(400);
                assertThat(((PdfException) e).code()).isEqualTo("pdf.unreadable");
            });
    }

    @Test
    void fileNamesKeepOnlySafeCharacters() {
        assertThat(PdfApi.filename("in take/../x")).isEqualTo("in-take-..-x.pdf");
        assertThat(PdfApi.filename("--")).isEqualTo("submission.pdf");
    }
}
