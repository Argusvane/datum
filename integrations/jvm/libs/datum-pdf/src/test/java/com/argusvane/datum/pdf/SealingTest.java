package com.argusvane.datum.pdf;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.pdf.verify.Certificates;
import com.argusvane.datum.timestamp.InMemoryTsaLog;
import com.argusvane.datum.timestamp.TimestampAuthority;
import com.argusvane.datum.timestamp.TimestampClientException;
import com.argusvane.datum.timestamp.TimestampToken;
import com.argusvane.datum.timestamp.Timestamper;
import com.argusvane.datum.timestamp.TsaKeyMaterial;
import java.nio.charset.StandardCharsets;
import java.security.Signature;
import java.security.cert.X509Certificate;
import java.time.Clock;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * The seal (the plan, attempt and seal calls) as {@link PdfService} makes it, over the kernel's
 * reply shapes and the PDF kernel's signing fixtures. The two-call protocol's host half: the handoff's
 * {@code toBeSigned} signed with the server's key (DER for ECDSA), optionally an RFC 3161 token over the value (the
 * whole TimeStampResp handed to {@code complete}), then {@code complete} with the same certificates, the echoed
 * digest and the field.
 */
class SealingTest {

    static final String LAYOUTS = "{\"id\":\"intake\",\"version\":\"1\",\"root\":{\"id\":\"root\",\"type\":\"form\",\"configuration\":{},"
        + "\"children\":{\"content\":[]}},\"pdf\":{\"defaultLayoutId\":\"copy\",\"layouts\":["
        + "{\"id\":\"copy\",\"kind\":\"generated\"},"
        + "{\"id\":\"summary\",\"kind\":\"generated\"},"
        + "{\"id\":\"certified\",\"kind\":\"generated\",\"signature\":{\"certify\":\"formFilling\",\"reason\":\"Issued by the office\",\"timestamp\":true,"
        + "\"commitment\":{\"type\":\"approval\",\"statement\":\"As submitted.\"}}},"
        + "{\"id\":\"required\",\"kind\":\"generated\",\"signature\":{\"required\":true}},"
        + "{\"id\":\"blank\",\"kind\":\"generated\",\"signature\":{\"commitment\":{\"type\":\"approval\",\"statement\":\" \"}}},"
        + "{\"id\":\"form-a\",\"kind\":\"template\"},"
        + "{\"id\":\"form-required\",\"kind\":\"template\",\"signature\":{\"required\":true}}]}}";

    static ObjectNode definition() {
        return (ObjectNode) TestAssets.JSON.readTree(LAYOUTS);
    }

    static ObjectNode values() {
        return TestAssets.JSON.createObjectNode();
    }

    static TimestampAuthority authority() {
        return new TimestampAuthority(TsaKeyMaterial.of(TestAssets.identity("tsa")), null, null, Clock.systemUTC(),
            new InMemoryTsaLog(Clock.systemUTC()));
    }

    private static PdfService.Builder builder(ScriptedPdfRuntime runtime) {
        return PdfService.builder().runtime(runtime.pdfRuntime());
    }

    @Test
    void nothingIsSealedWithoutThePresetOrALayoutBlock() {
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
        PdfService pdf = builder(runtime).signer(TestAssets.signer("rsa2048")).build();
        PdfResult result = pdf.renderSubmission(definition(), values(), "en", "copy", PdfOptions.defaults());
        assertThat(result.seal()).isNull();
        assertThat(runtime.requests("document").get(0).has("signature")).isFalse();
        assertThat(runtime.count("complete")).isZero();
    }

    @ParameterizedTest
    @ValueSource(strings = {"rsa2048", "p256", "p384", "chain-leaf"})
    void thePresetSealsEveryIssuedPdfWithTheServersKey(String name) throws Exception {
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
        KeyStorePdfSigner signer = TestAssets.signer(name);
        List<PdfRenderedEvent> events = new ArrayList<>();
        PdfService pdf = builder(runtime).signer(signer).seal(SealPreset.on()).events(event -> {
            if (event instanceof PdfRenderedEvent rendered) {
                events.add(rendered);
            }
        }).build();
        PdfResult result = pdf.renderSubmission(definition(), values(), "en", "copy", PdfOptions.defaults().withFormKey("intake"));

        ObjectNode prepared = runtime.requests("document").get(0);
        JsonNode spec = prepared.get("signature");
        assertThat(spec.path("certify").asString()).isEqualTo("noChanges");
        assertThat(spec.path("timestamp").asBoolean()).as("no timestamp server: no room reserved").isFalse();
        assertThat(spec.path("certificates")).hasSize(signer.chain().size());
        assertThat(spec.path("certificates").get(0).asString()).isEqualTo(signer.certificatesBase64().get(0));

        ObjectNode complete = runtime.requests("complete").get(0);
        JsonNode completion = complete.get("signing");
        assertThat(completion.path("field").asString()).isEqualTo("Signature1");
        assertThat(completion.path("certificates")).isEqualTo(spec.path("certificates"));
        assertThat(completion.has("timestamp")).isFalse();
        assertThat(completion.has("certify")).as("complete carries the value, certificates, digest and field only (PDF ABI complete op)").isFalse();
        // The value verifies over what the kernel handed out (the DER signed attributes over the prepared file's
        // byte range), with the leaf's key; the digest echoed is that of toBeSigned.
        byte[] preparedPdf = Base64.getDecoder().decode(complete.path("pdf").path("data").asString());
        byte[] toBeSigned = ScriptedPdfRuntime.signedAttributes(ScriptedPdfRuntime.digestOver(preparedPdf), null);
        byte[] value = Base64.getDecoder().decode(completion.path("value").asString());
        Signature verifier = Signature.getInstance(signer.keyAlgorithm().startsWith("RSA") ? "SHA256withRSA" : "SHA256withECDSA");
        verifier.initVerify(signer.leaf().getPublicKey());
        verifier.update(toBeSigned);
        assertThat(verifier.verify(value)).isTrue();
        assertThat(completion.path("toBeSignedDigest").asString())
            .isEqualTo(Base64.getEncoder().encodeToString(ScriptedPdfRuntime.sha256(toBeSigned)));

        assertThat(result.seal()).isNotNull();
        assertThat(result.seal().fingerprint()).isEqualTo(Certificates.fingerprint(signer.leaf()));
        assertThat(result.seal().subject()).isEqualTo(Certificates.subject(signer.leaf()));
        assertThat(result.seal().field()).isEqualTo("Signature1");
        assertThat(result.seal().timestamped()).isFalse();
        assertThat(result.seal().sha256()).isEqualTo(PdfService.sha256(result.bytes()));
        assertThat(result.signing()).as("a completed seal hands out nothing more to sign").isNull();
        assertThat(new String(result.bytes(), StandardCharsets.US_ASCII)).startsWith("%PDF-1.7\n% signed");
        assertThat(events).hasSize(1);
        assertThat(events.get(0).signed()).isTrue();
        assertThat(events.get(0).op()).isEqualTo("document");
        assertThat(events.get(0).layoutId()).isEqualTo("copy");
    }

    @Test
    void thePresetsWordsGoToTheKernelAndTheLayoutsOwnKeysWin() {
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
        SealPreset preset = new SealPreset(true, List.of(), SealPreset.Certify.ANNOTATE, true, "  Issued by the permit office  ", "Ottawa", false);
        PdfService pdf = builder(runtime).signer(TestAssets.signer("rsa2048")).seal(preset).build();
        pdf.renderSubmission(definition(), values(), "en", "copy", PdfOptions.defaults());
        JsonNode spec = runtime.requests("document").get(0).get("signature");
        assertThat(spec.path("certify").asString()).isEqualTo("annotations");
        assertThat(spec.path("reason").asString()).isEqualTo("Issued by the permit office");
        assertThat(spec.path("location").asString()).isEqualTo("Ottawa");
        assertThat(spec.path("appearance").isBoolean()).isTrue();
        assertThat(spec.path("appearance").asBoolean()).isFalse();

        pdf.renderSubmission(definition(), values(), "en", "certified", PdfOptions.defaults());
        JsonNode certified = runtime.requests("document").get(1).get("signature");
        assertThat(certified.has("certify")).as("the layout's certify wins: left to the program to merge").isFalse();
        assertThat(certified.has("reason")).isFalse();
        assertThat(certified.path("location").asString()).isEqualTo("Ottawa");
        // The layout's commitment is repeated on complete, as the kernel needs it.
        JsonNode commitment = runtime.requests("complete").get(1).path("signing").path("commitment");
        assertThat(commitment.path("type").asString()).isEqualTo("approval");
        assertThat(commitment.path("statement").asString()).isEqualTo("As submitted.");

        SealPreset approval = SealPreset.on().withCertify(SealPreset.Certify.NONE);
        ScriptedPdfRuntime second = new ScriptedPdfRuntime();
        builder(second).signer(TestAssets.signer("rsa2048")).seal(approval).build()
            .renderSubmission(definition(), values(), "en", "copy", PdfOptions.defaults());
        JsonNode plain = second.requests("document").get(0).get("signature");
        assertThat(plain.path("certify").isBoolean()).isTrue();
        assertThat(plain.path("certify").asBoolean()).isFalse();
    }

    @Test
    void aLongReasonIsCutAt500Characters() {
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
        String reason = "📝".repeat(600);
        PdfService pdf = builder(runtime).signer(TestAssets.signer("rsa2048"))
            .seal(new SealPreset(true, List.of(), SealPreset.Certify.NO_CHANGES, false, reason, null, null)).build();
        pdf.renderSubmission(definition(), values(), "en", "copy", PdfOptions.defaults());
        String sent = runtime.requests("document").get(0).path("signature").path("reason").asString();
        assertThat(sent.codePointCount(0, sent.length())).isEqualTo(500);
    }

    @Test
    void thePresetsLayoutListLimitsWhatIsSealed() {
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
        PdfService pdf = builder(runtime).signer(TestAssets.signer("rsa2048"))
            .seal(new SealPreset(true, List.of("summary"), SealPreset.Certify.NO_CHANGES, false, null, null, null)).build();
        assertThat(pdf.renderSubmission(definition(), values(), "en", "copy", PdfOptions.defaults()).seal()).isNull();
        assertThat(pdf.renderSubmission(definition(), values(), "en", "summary", PdfOptions.defaults()).seal()).isNotNull();
    }

    @Test
    void withoutAKeyThePresetWarnsAndDeliversUnsealed() {
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
        PdfService pdf = builder(runtime).seal(SealPreset.on()).build();
        PdfResult result = pdf.renderSubmission(definition(), values(), "en", "copy", PdfOptions.defaults());
        assertThat(result.seal()).isNull();
        assertThat(result.warnings()).anySatisfy(w -> {
            assertThat(w.path("code").asString()).isEqualTo("sealing.unavailable");
            assertThat(w.path("message").asString()).isEqualTo("The server seals its PDFs, and the server has no PDF signing key (datum.pdf.signing.*).");
        });
        assertThat(runtime.requests("document").get(0).has("signature")).isFalse();
    }

    @Test
    void aLayoutThatRequiresASealIsNeverDeliveredUnsealed() {
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
        PdfService pdf = builder(runtime).build();
        assertThatThrownBy(() -> pdf.renderSubmission(definition(), values(), "en", "required", PdfOptions.defaults()))
            .isInstanceOf(PdfException.class)
            .hasMessage("The PDF layout \"required\" requires a sealed PDF, and the server has no PDF signing key (datum.pdf.signing.*).")
            .satisfies(e -> assertThat(((PdfException) e).code()).isEqualTo("signature"));
        assertThat(runtime.count("document")).as("asked by id: refused before any render").isZero();
        // A layout's own non-required block without a key: no host warning (the program warns).
        PdfResult certified = pdf.renderSubmission(definition(), values(), "en", "certified", PdfOptions.defaults());
        assertThat(certified.warnings()).isEmpty();
    }

    @Test
    void aGuessThatWouldBeRefusedRendersUnsealedFirstAndTheChosenLayoutDecides() {
        // The definition's default layout requires a seal; the answers choose another.
        ObjectNode definition = definition();
        ((ObjectNode) definition.get("pdf")).put("defaultLayoutId", "required");
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime().on("document", body -> printed(body, "summary"));
        PdfService pdf = builder(runtime).build();
        PdfResult result = pdf.renderSubmission(definition, values(), "en", null, PdfOptions.defaults());
        assertThat(result.layoutId()).isEqualTo("summary");
        assertThat(runtime.count("document")).as("summary's plan is none, as the probe was: no second render").isEqualTo(1);
        assertThat(runtime.requests("document").get(0).has("signature")).isFalse();

        // The answers choose the layout that requires a seal: refused after the probe.
        ScriptedPdfRuntime chosen = new ScriptedPdfRuntime().on("document", body -> printed(body, "required"));
        PdfService refusing = builder(chosen).build();
        assertThatThrownBy(() -> refusing.renderSubmission(definition, values(), "en", null, PdfOptions.defaults()))
            .isInstanceOf(PdfException.class).hasMessageContaining("requires a sealed PDF");
        assertThat(chosen.count("document")).isEqualTo(1);
    }

    @Test
    void whenTheAnswersChooseAnotherLayoutItIsRenderedAgainByIdUnderItsOwnPlan() {
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime()
            .on("document", body -> printed(body, body.path("layoutId").isString() ? body.path("layoutId").stringValue() : "summary"));
        // The preset seals "copy" (the guess) and not "summary" (the answers' choice).
        PdfService pdf = builder(runtime).signer(TestAssets.signer("p256"))
            .seal(new SealPreset(true, List.of("copy"), SealPreset.Certify.NO_CHANGES, false, null, null, null)).build();
        PdfResult result = pdf.renderSubmission(definition(), values(), "en", null, PdfOptions.defaults());
        List<ObjectNode> documents = runtime.requests("document");
        assertThat(documents).hasSize(2);
        assertThat(documents.get(0).has("signature")).isTrue();
        assertThat(documents.get(0).has("layoutId")).isFalse();
        assertThat(documents.get(1).path("layoutId").asString()).isEqualTo("summary");
        assertThat(documents.get(1).has("signature")).isFalse();
        assertThat(result.layoutId()).isEqualTo("summary");
        assertThat(result.seal()).isNull();
        assertThat(runtime.count("complete")).isZero();
    }

    /** A document answer that prints the given layout (and prepares a signature when asked, as the kernel does). */
    private static String printed(ObjectNode body, String layout) {
        ObjectNode copy = body.deepCopy();
        copy.put("layoutId", layout);
        ScriptedPdfRuntime shapes = new ScriptedPdfRuntime();
        String answer = shapesOf(shapes, copy);
        ObjectNode parsed = (ObjectNode) TestAssets.JSON.readTree(answer);
        if (!body.path("layoutId").isString()) {
            parsed.put("layoutChoice", "condition");
        }
        return parsed.toString();
    }

    private static String shapesOf(ScriptedPdfRuntime shapes, ObjectNode body) {
        var output = shapes.run(com.argusvane.datum.sandbox.wasi.GuestRun.of(java.util.Map.of(), java.util.List.of(),
            body.toString().getBytes(StandardCharsets.UTF_8), com.argusvane.datum.sandbox.protocol.ProgramLimits.defaults().pdfBudget()));
        return new String(output.stdout(), StandardCharsets.UTF_8);
    }

    @Test
    void aTimestampFromTheInProcessAuthorityGoesWholeToComplete() {
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
        KeyStorePdfSigner signer = TestAssets.signer("p256");
        PdfService pdf = builder(runtime).signer(signer).seal(SealPreset.on()).timestamper(authority(), "site").build();
        assertThat(pdf.timestampAvailable()).isTrue();
        assertThat(pdf.timestampSource()).isEqualTo("site");
        PdfResult result = pdf.renderSubmission(definition(), values(), "en", "copy", PdfOptions.defaults());
        assertThat(runtime.requests("document").get(0).path("signature").path("timestamp").asBoolean()).as("room reserved").isTrue();
        JsonNode completion = runtime.requests("complete").get(0).get("signing");
        byte[] value = Base64.getDecoder().decode(completion.path("value").asString());
        byte[] reply = Base64.getDecoder().decode(completion.path("timestamp").path("token").asString());
        // The whole TimeStampResp, granted, over this value's SHA-256.
        assertThat(reply[0]).isEqualTo((byte) 0x30);
        TimestampToken token = TimestampToken.fromResponse(reply);
        assertThat(token.covers(value)).isTrue();
        assertThat(token.algorithm()).isEqualTo("sha256");
        assertThat(result.seal().timestamped()).isTrue();
        assertThat(result.timestamped()).isTrue();
    }

    @Test
    void aTimestampServerThatDoesNotAnswerCostsTheTimestampNotTheSeal() {
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
        Timestamper down = (data, channel) -> {
            throw new TimestampClientException(503, "The timestamp server https://tsa.example.com/tsr answered 503.");
        };
        PdfService pdf = builder(runtime).signer(TestAssets.signer("rsa2048")).seal(SealPreset.on()).timestamper(down, "https://tsa.example.com/tsr").build();
        PdfResult result = pdf.renderSubmission(definition(), values(), "en", "copy", PdfOptions.defaults());
        assertThat(result.seal()).isNotNull();
        assertThat(result.seal().timestamped()).isFalse();
        assertThat(result.warnings()).anySatisfy(w -> {
            assertThat(w.path("code").asString()).isEqualTo("sealing.timestamp");
            assertThat(w.path("message").asString()).isEqualTo("The timestamp server https://tsa.example.com/tsr answered 503. The PDF is sealed without one.");
        });
        assertThat(runtime.requests("complete").get(0).path("signing").has("timestamp")).isFalse();
    }

    @Test
    void aTokenTheProgramRefusesCostsTheTimestampNotTheSeal() {
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
        TimestampAuthority authority = authority();
        // A token over other bytes: the kernel refuses it ("vouches for a different signature value").
        Timestamper wrong = (data, channel) -> authority.stamp("something else".getBytes(StandardCharsets.US_ASCII), channel);
        PdfService pdf = builder(runtime).signer(TestAssets.signer("rsa2048")).seal(SealPreset.on()).timestamper(wrong, "site").build();
        PdfResult result = pdf.renderSubmission(definition(), values(), "en", "copy", PdfOptions.defaults());
        assertThat(runtime.requests("complete")).hasSize(2);
        assertThat(runtime.requests("complete").get(0).path("signing").has("timestamp")).isTrue();
        assertThat(runtime.requests("complete").get(1).path("signing").has("timestamp")).isFalse();
        assertThat(result.seal().timestamped()).isFalse();
        assertThat(result.warnings()).anySatisfy(w -> assertThat(w.path("message").asString())
            .isEqualTo("The timestamp server’s token was refused: The timestamp token vouches for a different signature value."));
    }

    @Test
    void aRefusalOfCompleteWithoutATimestampFailsTheSeal() {
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime().on("complete", body -> ScriptedPdfRuntime.failure("signature", "no room"));
        PdfService pdf = builder(runtime).signer(TestAssets.signer("rsa2048")).seal(SealPreset.on()).build();
        assertThatThrownBy(() -> pdf.renderSubmission(definition(), values(), "en", "copy", PdfOptions.defaults()))
            .isInstanceOf(PdfException.class).satisfies(e -> assertThat(((PdfException) e).kernelMessage()).isEqualTo("no room"));
        assertThat(runtime.count("complete")).isEqualTo(1);
    }

    @Test
    void anEcdsaSignerThatHandsOverP1363IsRefusedBeforeComplete() throws Exception {
        KeyStorePdfSigner real = TestAssets.signer("p256");
        PdfSigner p1363 = new PdfSigner() {
            @Override
            public List<X509Certificate> chain() {
                return real.chain();
            }

            @Override
            public byte[] sign(byte[] toBeSigned, String algorithm) {
                try {
                    Signature signature = Signature.getInstance("SHA256withECDSAinP1363Format");
                    signature.initSign(TestAssets.identity("p256").privateKey());
                    signature.update(toBeSigned);
                    return signature.sign();
                } catch (Exception e) {
                    throw new IllegalStateException(e);
                }
            }
        };
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
        PdfService pdf = builder(runtime).signer(p1363).seal(SealPreset.on()).build();
        assertThatThrownBy(() -> pdf.renderSubmission(definition(), values(), "en", "copy", PdfOptions.defaults()))
            .isInstanceOf(PdfException.class).hasMessageContaining("not DER")
            .satisfies(e -> assertThat(((PdfException) e).code()).isEqualTo("signature"));
        assertThat(runtime.count("complete")).isZero();
    }

    @Test
    void aSignerWhoseValueDoesNotVerifyWithItsOwnCertificateIsRefused() {
        KeyStorePdfSigner claimed = TestAssets.signer("rsa2048");
        PdfSigner lying = new PdfSigner() {
            @Override
            public List<X509Certificate> chain() {
                return claimed.chain();
            }

            @Override
            public byte[] sign(byte[] toBeSigned, String algorithm) {
                // A KMS key that is not the certificate's.
                return TestAssets.signer("chain-leaf").sign(toBeSigned, "RSASSA-PKCS1-v1_5-SHA256");
            }
        };
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
        PdfService pdf = builder(runtime).signer(lying).seal(SealPreset.on()).build();
        assertThatThrownBy(() -> pdf.renderSubmission(definition(), values(), "en", "copy", PdfOptions.defaults()))
            .isInstanceOf(PdfException.class).hasMessageContaining("does not verify with its own certificate");
        assertThat(runtime.count("complete")).isZero();
    }

    @Test
    void aSignerThatThrowsIsASignatureRefusal() {
        KeyStorePdfSigner real = TestAssets.signer("rsa2048");
        PdfSigner broken = new PdfSigner() {
            @Override
            public List<X509Certificate> chain() {
                return real.chain();
            }

            @Override
            public byte[] sign(byte[] toBeSigned, String algorithm) {
                throw new IllegalStateException("HSM offline");
            }
        };
        PdfService pdf = builder(new ScriptedPdfRuntime()).signer(broken).seal(SealPreset.on()).build();
        assertThatThrownBy(() -> pdf.renderSubmission(definition(), values(), "en", "copy", PdfOptions.defaults()))
            .isInstanceOf(PdfException.class).hasMessage("The server's key could not sign the PDF.")
            .hasCauseInstanceOf(IllegalStateException.class);
    }

    @Test
    void aHandoffWithNothingToSignIsRefused() {
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime().on("document", body -> {
            ObjectNode answer = (ObjectNode) TestAssets.JSON.readTree(shapesOf(new ScriptedPdfRuntime(), body));
            ((ObjectNode) answer.get("signing")).put("toBeSigned", "");
            return answer.toString();
        });
        PdfService pdf = builder(runtime).signer(TestAssets.signer("rsa2048")).seal(SealPreset.on()).build();
        assertThatThrownBy(() -> pdf.renderSubmission(definition(), values(), "en", "copy", PdfOptions.defaults()))
            .isInstanceOf(PdfException.class).hasMessage("The PDF program handed out nothing to sign.");
    }

    @Test
    void aPreparedRequestWithoutAHandoffIsRefused() {
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime().on("document", body -> {
            ObjectNode answer = (ObjectNode) TestAssets.JSON.readTree(shapesOf(new ScriptedPdfRuntime(), body));
            answer.remove("signing");
            return answer.toString();
        });
        PdfService pdf = builder(runtime).signer(TestAssets.signer("rsa2048")).seal(SealPreset.on()).build();
        assertThatThrownBy(() -> pdf.renderSubmission(definition(), values(), "en", "copy", PdfOptions.defaults()))
            .isInstanceOf(PdfException.class).hasMessage("The PDF program prepared no signature.");
    }

    @Test
    void aTemplateTheCallerPostedIsNeverSealedWithTheServersKey() {
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
        PdfService pdf = builder(runtime).signer(TestAssets.signer("rsa2048")).seal(SealPreset.on()).build();
        byte[] template = "%PDF-1.7 the caller's pages".getBytes(StandardCharsets.US_ASCII);
        PdfResult posted = pdf.fillSubmission(definition(), values(), "en", "form-a", template, true, PdfOptions.defaults());
        assertThat(posted.seal()).isNull();
        assertThat(runtime.requests("document").get(0).has("signature")).isFalse();
        assertThat(runtime.requests("document").get(0).path("template").path("data").asString())
            .isEqualTo(Base64.getEncoder().encodeToString(template));
        assertThat(posted.warnings()).anySatisfy(w -> assertThat(w.path("message").asString()).contains("a template the caller posted is never sealed"));
        assertThatThrownBy(() -> pdf.fillSubmission(definition(), values(), "en", "form-required", template, true, PdfOptions.defaults()))
            .isInstanceOf(PdfException.class).hasMessageContaining("requires a sealed PDF, and a template the caller posted");
        // The host's own template is sealed as any issued PDF.
        assertThat(pdf.fillSubmission(definition(), values(), "en", "form-a", template, false, PdfOptions.defaults()).seal()).isNotNull();
        assertThatThrownBy(() -> pdf.fillSubmission(definition(), values(), "en", "nowhere", template, false, PdfOptions.defaults()))
            .isInstanceOf(PdfException.class).satisfies(e -> assertThat(((PdfException) e).httpStatus()).isEqualTo(404));
    }

    @Test
    void aGeneratedLayoutIsNeverFilledSoACallersTemplateCannotUnsealIt() {
        // The program would print the generated layout and ignore the bytes: the server's own PDF, which the posted
        // template must not send out unsealed.
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
        PdfService pdf = builder(runtime).signer(TestAssets.signer("rsa2048")).seal(SealPreset.on()).build();
        byte[] template = "%PDF-1.7 the caller's pages".getBytes(StandardCharsets.US_ASCII);
        assertThatThrownBy(() -> pdf.fillSubmission(definition(), values(), "en", "copy", template, true, PdfOptions.defaults()))
            .isInstanceOf(PdfException.class)
            .satisfies(e -> {
                assertThat(((PdfException) e).code()).isEqualTo(PdfException.LAYOUT_NOT_TEMPLATE);
                assertThat(((PdfException) e).httpStatus()).isEqualTo(400);
            });
        assertThat(runtime.requests()).isEmpty();
    }

    @Test
    void aDocumentRequestCarryingATemplateIsTheCallersUnlessTheHostSaysItIsItsOwn() {
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
        PdfService pdf = builder(runtime).signer(TestAssets.signer("rsa2048")).seal(SealPreset.on()).build();
        ObjectNode request = (ObjectNode) TestAssets.JSON.readTree("{\"form\":{\"id\":\"root\",\"type\":\"form\"},\"values\":{},\"locale\":\"en\","
            + "\"template\":{\"data\":\"" + Base64.getEncoder().encodeToString("%PDF-1.7 an upload".getBytes(StandardCharsets.US_ASCII)) + "\"}}");
        PdfResult upload = pdf.document(request, PdfOptions.defaults());
        assertThat(upload.seal()).isNull();
        assertThat(runtime.requests("document").get(0).has("signature")).isFalse();
        assertThat(upload.warnings()).anySatisfy(w -> assertThat(w.path("message").asString()).contains("a template the caller posted is never sealed"));
        assertThat(pdf.document(request, PdfOptions.defaults(), true).signed()).as("the host's own template").isTrue();
        // Without a template the preset seals.
        request.remove("template");
        assertThat(pdf.document(request, PdfOptions.defaults()).signed()).isTrue();
    }

    @Test
    void signSubmissionSealsWhateverThePresetSaysAndNeedsAKey() {
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
        PdfService pdf = builder(runtime).signer(TestAssets.signer("rsa2048")).build();
        assertThat(pdf.sealPreset().enabled()).isFalse();
        PdfResult signed = pdf.signSubmission(definition(), values(), "en", "copy", PdfOptions.defaults());
        assertThat(signed.seal()).isNotNull();
        assertThat(runtime.requests("document").get(0).path("signature").path("certify").asString()).isEqualTo("noChanges");
        assertThatThrownBy(() -> builder(new ScriptedPdfRuntime()).build().signSubmission(definition(), values(), "en", "copy", PdfOptions.defaults()))
            .isInstanceOf(PdfUnavailableException.class);
    }

    @Test
    void theTwoCallsByHandAndTheServersSealOfAnyPdf() {
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
        KeyStorePdfSigner signer = TestAssets.signer("p384");
        PdfService pdf = builder(runtime).signer(signer).timestamper(authority(), "site").build();
        byte[] input = "%PDF-1.7 any".getBytes(StandardCharsets.US_ASCII);
        ObjectNode spec = TestAssets.JSON.createObjectNode();
        spec.put("certify", "noChanges");
        signer.certificatesBase64().forEach(spec.putArray("certificates")::add);
        PdfResult prepared = pdf.sign(input, spec, PdfOptions.defaults());
        assertThat(prepared.signing().signatureAlgorithm()).isEqualTo("ECDSA-P384-SHA256");
        byte[] value = signer.sign(Base64.getDecoder().decode(prepared.signing().toBeSigned()), prepared.signing().signatureAlgorithm());
        ObjectNode completion = TestAssets.JSON.createObjectNode();
        completion.put("value", Base64.getEncoder().encodeToString(value));
        signer.certificatesBase64().forEach(completion.putArray("certificates")::add);
        completion.put("toBeSignedDigest", prepared.signing().toBeSignedDigest());
        PdfService.Completed completed = pdf.complete(prepared.bytes(), completion, "intake");
        assertThat(completed.field()).isEqualTo("Signature1");
        assertThat(completed.timestamped()).isFalse();
        // A changed input between sign and complete is the kernel's to catch.
        completion.put("toBeSignedDigest", Base64.getEncoder().encodeToString(new byte[32]));
        assertThatThrownBy(() -> pdf.complete(prepared.bytes(), completion, null)).isInstanceOf(PdfException.class);

        ObjectNode settings = TestAssets.JSON.createObjectNode();
        settings.put("reason", "Countersigned");
        settings.put("timestamp", true);
        settings.putArray("certificates").add("not the server's");
        settings.put("abi", "1.0.0");
        PdfResult sealed = pdf.signWithServerKey(input, settings, PdfOptions.defaults());
        JsonNode sent = runtime.requests("sign").get(1).get("signature");
        assertThat(sent.path("reason").asString()).isEqualTo("Countersigned");
        assertThat(sent.path("certificates").get(0).asString()).as("always the server's certificates").isEqualTo(signer.certificatesBase64().get(0));
        assertThat(sent.has("abi")).isFalse();
        assertThat(sealed.seal().timestamped()).isTrue();
        assertThatThrownBy(() -> builder(new ScriptedPdfRuntime()).build().signWithServerKey(input, settings, PdfOptions.defaults()))
            .isInstanceOf(PdfUnavailableException.class);
    }

    @Test
    void theCertifyWordsOfTheBriefAndOfTheKernelBothRead() {
        assertThat(SealPreset.Certify.parse("noChanges").permissions()).isEqualTo(1);
        assertThat(SealPreset.Certify.parse("formFill").kernelWord()).isEqualTo("formFilling");
        assertThat(SealPreset.Certify.parse("formFilling").permissions()).isEqualTo(2);
        assertThat(SealPreset.Certify.parse("annotate").kernelWord()).isEqualTo("annotations");
        assertThat(SealPreset.Certify.parse("annotations").permissions()).isEqualTo(3);
        assertThat(SealPreset.Certify.parse("none").kernelWord()).isNull();
        assertThatThrownBy(() -> SealPreset.Certify.parse("everything")).isInstanceOf(IllegalArgumentException.class);
    }

    // -------------------------------------------------------------------------------------------------------------

    @Test
    void aCommitmentIsRepeatedOnCompleteExactlyAsTheProgramSignedIt() {
        // The kernel keeps a whitespace-only statement in the signed attributes (it drops only ""): complete must get
        // the same commitment, or it rebuilds other attributes and refuses them.
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
        PdfService pdf = builder(runtime).signer(TestAssets.signer("rsa2048")).seal(SealPreset.on()).build();
        PdfResult blank = pdf.renderSubmission(definition(), values(), "en", "blank", PdfOptions.defaults());
        assertThat(blank.signed()).isTrue();
        JsonNode repeated = runtime.requests("complete").get(0).path("signing").path("commitment");
        assertThat(repeated.path("type").asString()).isEqualTo("approval");
        assertThat(repeated.path("statement").asString()).isEqualTo(" ");

        ScriptedPdfRuntime any = new ScriptedPdfRuntime();
        PdfService server = builder(any).signer(TestAssets.signer("p256")).build();
        ObjectNode settings = (ObjectNode) TestAssets.JSON.readTree("{\"commitment\":{\"type\":\"approval\",\"statement\":\" \"}}");
        PdfResult sealed = server.signWithServerKey("%PDF-1.7 any".getBytes(StandardCharsets.US_ASCII), settings, PdfOptions.defaults());
        assertThat(sealed.signed()).isTrue();
        assertThat(any.requests("complete").get(0).path("signing").path("commitment").path("statement").asString()).isEqualTo(" ");
        assertThat(any.count("complete")).isEqualTo(1);
    }

    /** A signer that records whether it was asked to sign. */
    private static final class Watching implements PdfSigner {
        final KeyStorePdfSigner real = TestAssets.signer("rsa2048");
        int signed;

        @Override
        public List<X509Certificate> chain() {
            return real.chain();
        }

        @Override
        public byte[] sign(byte[] toBeSigned, String algorithm) {
            signed++;
            return real.sign(toBeSigned, algorithm);
        }
    }

    /** A document answer whose signing handoff is changed by {@code tamper} after the kernel's shape is made. */
    private static ScriptedPdfRuntime tampered(java.util.function.BiConsumer<ObjectNode, byte[]> tamper) {
        return new ScriptedPdfRuntime().on("document", body -> {
            ObjectNode answer = (ObjectNode) TestAssets.JSON.readTree(shapesOf(new ScriptedPdfRuntime(), body));
            tamper.accept((ObjectNode) answer.get("signing"), Base64.getDecoder().decode(answer.path("bytes").asString()));
            return answer.toString();
        });
    }

    private static String b64(byte[] bytes) {
        return Base64.getEncoder().encodeToString(bytes);
    }

    @Test
    void theServersKeySignsOnlySignedAttributesOverThePreparedFile() {
        byte[] other = ScriptedPdfRuntime.sha256("another document".getBytes(StandardCharsets.US_ASCII));
        List<java.util.function.BiConsumer<ObjectNode, byte[]>> tampers = List.of(
            // Attributes over another document's digest, with a digest of their own that matches them.
            (signing, pdf) -> {
                byte[] foreign = ScriptedPdfRuntime.signedAttributes(other, null);
                signing.put("toBeSigned", b64(foreign));
                signing.put("toBeSignedDigest", b64(ScriptedPdfRuntime.sha256(foreign)));
            },
            // The handoff's digest is not the file's.
            (signing, pdf) -> signing.put("digest", b64(other)),
            // toBeSignedDigest is not the digest of toBeSigned.
            (signing, pdf) -> signing.put("toBeSignedDigest", b64(other)),
            // A byte range that stops short of the end of the file.
            (signing, pdf) -> {
                signing.putArray("byteRange").add(0).add(10).add(20).add(pdf.length - 21);
            },
            // A byte range with no gap.
            (signing, pdf) -> signing.putArray("byteRange").add(0).add(20).add(20).add(pdf.length - 20),
            // Not DER signed attributes at all (but their digest echoed).
            (signing, pdf) -> {
                byte[] text = "sign me".getBytes(StandardCharsets.US_ASCII);
                signing.put("toBeSigned", b64(text));
                signing.put("toBeSignedDigest", b64(ScriptedPdfRuntime.sha256(text)));
            },
            // Every attribute carries a third element (valid DER, the right digest, not SEQUENCE { OID, SET }).
            (signing, pdf) -> {
                try {
                    byte[] good = Base64.getDecoder().decode(signing.path("toBeSigned").asString());
                    org.bouncycastle.asn1.ASN1Set set = (org.bouncycastle.asn1.ASN1Set) org.bouncycastle.asn1.ASN1Primitive.fromByteArray(good);
                    org.bouncycastle.asn1.ASN1EncodableVector widened = new org.bouncycastle.asn1.ASN1EncodableVector();
                    for (org.bouncycastle.asn1.ASN1Encodable each : set) {
                        org.bouncycastle.asn1.ASN1EncodableVector one = new org.bouncycastle.asn1.ASN1EncodableVector();
                        for (org.bouncycastle.asn1.ASN1Encodable part : (org.bouncycastle.asn1.ASN1Sequence) each) {
                            one.add(part);
                        }
                        one.add(org.bouncycastle.asn1.DERNull.INSTANCE);
                        widened.add(new org.bouncycastle.asn1.DERSequence(one));
                    }
                    byte[] extra = new org.bouncycastle.asn1.DERSet(widened).getEncoded(org.bouncycastle.asn1.ASN1Encoding.DER);
                    signing.put("toBeSigned", b64(extra));
                    signing.put("toBeSignedDigest", b64(ScriptedPdfRuntime.sha256(extra)));
                } catch (java.io.IOException e) {
                    throw new IllegalStateException(e);
                }
            },
            // Two messageDigest attributes, the second over another document.
            (signing, pdf) -> {
                byte[] good = Base64.getDecoder().decode(signing.path("toBeSigned").asString());
                byte[] foreign = ScriptedPdfRuntime.signedAttributes(other, null);
                // SET { good's attributes..., foreign's attributes... }: lengths below 128 + 128 bytes, so rebuild.
                byte[] inner = concat(content(good), content(foreign));
                byte[] doubled = concat(new byte[] {0x31, (byte) 0x81, (byte) inner.length}, inner);
                signing.put("toBeSigned", b64(doubled));
                signing.put("toBeSignedDigest", b64(ScriptedPdfRuntime.sha256(doubled)));
            });
        for (java.util.function.BiConsumer<ObjectNode, byte[]> tamper : tampers) {
            ScriptedPdfRuntime runtime = tampered(tamper);
            Watching key = new Watching();
            PdfService pdf = builder(runtime).signer(key).seal(SealPreset.on()).build();
            assertThatThrownBy(() -> pdf.renderSubmission(definition(), values(), "en", "copy", PdfOptions.defaults()))
                .isInstanceOf(PdfException.class)
                .satisfies(e -> {
                    assertThat(((PdfException) e).code()).isEqualTo("signature");
                    assertThat(((PdfException) e).httpStatus()).isEqualTo(500);
                });
            assertThat(key.signed).as("the server's key signed nothing").isZero();
            assertThat(runtime.count("complete")).isZero();
        }
    }

    /** The content of a short-form or one-length-byte DER header. */
    private static byte[] content(byte[] der) {
        int offset = (der[1] & 0x80) == 0 ? 2 : 2 + (der[1] & 0x7f);
        return java.util.Arrays.copyOfRange(der, offset, der.length);
    }

    private static byte[] concat(byte[] a, byte[] b) {
        byte[] out = java.util.Arrays.copyOf(a, a.length + b.length);
        System.arraycopy(b, 0, out, a.length, b.length);
        return out;
    }

    @Test
    void aTimestamperThatAnswersNothingCostsTheTimestampWithAWarning() {
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
        Timestamper silent = (data, channel) -> null;
        PdfService pdf = builder(runtime).signer(TestAssets.signer("rsa2048")).seal(SealPreset.on()).timestamper(silent, "site").build();
        PdfResult result = pdf.renderSubmission(definition(), values(), "en", "copy", PdfOptions.defaults());
        assertThat(result.signed()).isTrue();
        assertThat(result.timestamped()).isFalse();
        assertThat(result.warnings()).anySatisfy(w -> {
            assertThat(w.path("code").asString()).isEqualTo("sealing.timestamp");
            assertThat(w.path("message").asString()).isEqualTo("The timestamp server gave no token. The PDF is sealed without one.");
        });
        assertThat(runtime.requests("complete").get(0).path("signing").has("timestamp")).isFalse();
    }

    @Test
    void timestampedIsWhatTheProgramEmbeddedNotWhatWasHandedOver() {
        // complete succeeds, but the program says no token went in: neither the seal nor the event may claim one.
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
        ScriptedPdfRuntime kernel = new ScriptedPdfRuntime();
        runtime.on("document", body -> shapesOf(kernel, body));
        runtime.on("complete", body -> {
            ObjectNode answer = (ObjectNode) TestAssets.JSON.readTree(shapesOf(kernel, body));
            answer.put("timestamped", false);
            return answer.toString();
        });
        List<PdfRenderedEvent> events = new ArrayList<>();
        PdfService pdf = builder(runtime).signer(TestAssets.signer("p256")).seal(SealPreset.on()).timestamper(authority(), "site")
            .events(event -> {
            if (event instanceof PdfRenderedEvent rendered) {
                events.add(rendered);
            }
        }).build();
        PdfResult result = pdf.renderSubmission(definition(), values(), "en", "copy", PdfOptions.defaults());
        assertThat(runtime.requests("complete").get(0).path("signing").has("timestamp")).as("a token was handed over").isTrue();
        assertThat(result.signed()).isTrue();
        assertThat(result.timestamped()).isFalse();
        assertThat(result.warnings()).anySatisfy(w -> assertThat(w.path("message").asString()).contains("did not embed the timestamp token"));
        assertThat(events.get(0).timestamped()).isFalse();
    }

    @Test
    void answersNeverSubmittedAreSealedWithAThrowawayCertificateNeverTheServersKey() throws Exception {
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
        KeyStorePdfSigner server = TestAssets.signer("rsa2048");
        List<PdfRenderedEvent> events = new ArrayList<>();
        PdfService pdf = builder(runtime).signer(server).seal(SealPreset.on()).timestamper(authority(), "site").events(event -> {
            if (event instanceof PdfRenderedEvent rendered) {
                events.add(rendered);
            }
        }).build();
        PdfResult test = pdf.renderSubmission(definition(), values(), "en", "certified", PdfOptions.defaults(), PdfService.SealMode.TEST);
        JsonNode spec = runtime.requests("document").get(0).get("signature");
        X509Certificate leaf = Certificates.fromBase64(spec.path("certificates").get(0).asString());
        assertThat(spec.path("certificates")).hasSize(1);
        assertThat(spec.path("certificates").get(0).asString()).isNotEqualTo(server.certificatesBase64().get(0));
        assertThat(spec.path("reason").asString()).as("over the layout's own reason").isEqualTo(TestSeal.REASON);
        assertThat(spec.path("timestamp").asBoolean()).as("a test seal asks no timestamp server").isFalse();
        // The test seal's certificate: ECDSA P-256, self-signed, a day, CA:FALSE, digitalSignature + nonRepudiation.
        assertThat(leaf.getSubjectX500Principal().getName()).isEqualTo("CN=" + TestSeal.COMMON_NAME);
        assertThat(Certificates.selfSigned(leaf)).isTrue();
        assertThat(com.argusvane.datum.timestamp.TsaCertificateRules.algorithm(leaf)).isEqualTo("EC-P256");
        assertThat(leaf.getNotAfter().getTime() - leaf.getNotBefore().getTime()).isEqualTo(24L * 3600 * 1000);
        assertThat(leaf.getBasicConstraints()).isEqualTo(-1);
        assertThat(leaf.getKeyUsage()[0]).isTrue();
        assertThat(leaf.getKeyUsage()[1]).isTrue();
        assertThat(leaf.getCriticalExtensionOIDs()).contains("2.5.29.19", "2.5.29.15");
        assertThat(runtime.requests("complete").get(0).path("signing").path("certificates").get(0).asString())
            .isEqualTo(spec.path("certificates").get(0).asString());
        assertThat(test.seal()).isNotNull();
        assertThat(test.seal().test()).isTrue();
        assertThat(test.seal().subject()).isEqualTo("CN=" + TestSeal.COMMON_NAME);
        assertThat(test.signed()).as("not the server's seal").isFalse();
        assertThat(test.timestamped()).isFalse();
        assertThat(events).hasSize(1);
        assertThat(events.get(0).signed()).as("a listener recording issued PDFs leaves it out").isFalse();

        // One throwaway key per issue: a plan made twice does not differ by its certificate alone.
        PdfService.TestKey key = new PdfService.TestKey(Clock.systemUTC());
        assertThat(pdf.plan("copy", definition(), PdfService.SealMode.TEST, key).spec())
            .isEqualTo(pdf.plan("copy", definition(), PdfService.SealMode.TEST, key).spec());
        // Each issue a new one: nothing of a test seal is remembered.
        pdf.renderSubmission(definition(), values(), "en", "copy", PdfOptions.defaults(), PdfService.SealMode.TEST);
        assertThat(runtime.requests("document").get(1).path("signature").path("certificates").get(0).asString())
            .isNotEqualTo(spec.path("certificates").get(0).asString());
    }

    @Test
    void aTestSealIsPlannedAsARealOne() {
        // Preset off and no block: nothing to seal, as for a real issue.
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
        PdfService off = builder(runtime).signer(TestAssets.signer("rsa2048")).build();
        assertThat(off.renderSubmission(definition(), values(), "en", "copy", PdfOptions.defaults(), PdfService.SealMode.TEST).seal()).isNull();
        // TEST_FORCE seals whatever the preset says, with the throwaway key.
        PdfResult forced = off.renderSubmission(definition(), values(), "en", "copy", PdfOptions.defaults(), PdfService.SealMode.TEST_FORCE);
        assertThat(forced.seal().test()).isTrue();
        assertThat(runtime.requests("document").get(1).path("signature").path("certify").asString()).isEqualTo("noChanges");
        // A server that signs no PDFs makes no test seal: the layout that requires one fails as a real issue would,
        // the preset's wish warns, and a forced seal is refused.
        PdfService keyless = builder(new ScriptedPdfRuntime()).seal(SealPreset.on()).build();
        assertThatThrownBy(() -> keyless.renderSubmission(definition(), values(), "en", "required", PdfOptions.defaults(), PdfService.SealMode.TEST))
            .isInstanceOf(PdfException.class).hasMessageContaining("requires a sealed PDF, and the server has no PDF signing key");
        PdfResult note = keyless.renderSubmission(definition(), values(), "en", "copy", PdfOptions.defaults(), PdfService.SealMode.TEST);
        assertThat(note.seal()).isNull();
        assertThat(note.warnings()).anySatisfy(w -> assertThat(w.path("message").asString())
            .isEqualTo("The test PDF is not sealed: the server has no PDF signing key (datum.pdf.signing.*)."));
        assertThatThrownBy(() -> keyless.renderSubmission(definition(), values(), "en", "copy", PdfOptions.defaults(), PdfService.SealMode.TEST_FORCE))
            .isInstanceOf(PdfUnavailableException.class);
    }
}
