package com.argusvane.datum.core.contracts;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.core.RepoFixtures;
import com.argusvane.datum.core.canonical.CanonicalJson;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * Each record family reads real or contract-shaped JSON and writes the same document back, numbers
 * normalized the way the canonical form does (612 and 612.0 are one number on the wire).
 */
class ContractsRoundTripTest {

    private static final ObjectMapper MAPPER = RepoFixtures.MAPPER;
    /**
     * The kernel's structure limits as its check answers them ({@code limits};
     * {@code kernelStructureLimits()} in engine/form-engine/core/expressions/definition-structure.ts).
     */
    private static final String KERNEL_LIMITS = "{\"depth\":32,\"components\":10000,\"optionsPerComponent\":2000,\"optionsTotal\":50000,"
        + "\"locales\":64,\"journeys\":32,\"pages\":1000,\"routesPerPage\":64,\"pdfLayouts\":64,\"problems\":200}";

    private static <T> T roundTrip(Class<T> type, JsonNode json) {
        T value = MAPPER.readValue(json.toString(), type);
        JsonNode back = MAPPER.valueToTree(value);
        assertThat(CanonicalJson.serialize(back)).isEqualTo(CanonicalJson.serialize(json));
        return value;
    }

    private static <T> T roundTrip(Class<T> type, String json) {
        return roundTrip(type, MAPPER.readTree(json));
    }

    // ---------------------------------------------------------------- sandbox

    @Test
    void sandboxRequestWithTheSecurityFixtureDefinition() {
        JsonNode definition = RepoFixtures.json("packages/conformance-suite/fixtures/endpoint-fixture.definition.json");
        JsonNode request = MAPPER.readTree("""
            {"context": {"formId": "datum-security-suite", "values": {"name": "Ada", "10": 1}, "locale": "en",
               "externalData": {"k": [1, 2]}, "unknownFields": "strip", "logLevel": "warn", "page": "p1", "today": "2026-10-15",
               "formulaErrors": "fail", "riskyPatterns": "refuse", "reportFold": true,
               "document": {"versionContext": {}, "submission": {"locale": "en", "values": {}}},
               "optionSnapshot": {"src": [{"value": "a", "label": "A"}, {"value": "b"}]}},
             "policy": {"allowNetwork": false, "allowFilesystem": false, "allowProcess": false, "allowEnvironment": false,
               "allowedExternalDataKeys": ["k"]}}
            """);
        ((tools.jackson.databind.node.ObjectNode) request.get("context")).set("form", definition.get("root"));
        SandboxRequest read = roundTrip(SandboxRequest.class, request);
        assertThat(read.context().formId()).isEqualTo("datum-security-suite");
        assertThat(read.context().reportFold()).isTrue();
        assertThat(read.context().optionSnapshot().get("src")).extracting(OptionItem::value).containsExactly("a", "b");
        assertThat(read.policy().allowNetwork()).isFalse();
    }

    @Test
    void sandboxOutcomeWithEveryResult() {
        SandboxOutcome outcome = roundTrip(SandboxOutcome.class, """
            {"errors": [{"code": "required", "componentId": "name", "path": "name", "stage": "field-constraints", "source": "wasm",
                         "parameters": {"keys": ["a"]}}, {"code": "x", "stage": "s", "source": "wasm", "severity": "warning"}],
             "values": {"name": "Ada", "list": [1, 2.5]},
             "logs": [{"level": "warn", "message": "m", "data": {"a": 1}}, {"level": "info", "message": "n"}],
             "clientDerived": ["calc"], "pageComponentIds": ["a"], "clockDependent": ["d"], "serverRules": ["s"],
             "visibilitySkipped": ["v"], "withheld": ["w"],
             "effectiveState": {"a": {"visible": false, "disabled": false, "readonly": false, "runValidation": false,
                                      "requiredApplies": false, "submitValue": true, "clearValue": true}},
             "submittable": {"a": 1},
             "trace": {"pages": ["p1", "p2", "p3"], "end": "exit", "decisions": [
                 {"kind": "next", "pageId": "p0", "to": "p1"}, {"kind": "route", "pageId": "p1", "routeIndex": 0, "to": "p2"},
                 {"kind": "next", "pageId": "p2", "to": "p3"}]},
             "index": [{"path": "list", "delta": "0", "value": 1}, {"path": "name", "delta": "", "value": "Ada"}],
             "canonical": "{}", "digest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"}
            """);
        assertThat(outcome.errors()).hasSize(2);
        assertThat(outcome.trace().decisions()).hasSize(3);
        assertThat(outcome.effectiveState().get("a").visible()).isFalse();
        assertThat(outcome.index().get(0).delta()).isEqualTo("0");
    }

    @Test
    void anOutcomeKeepsFieldsFromANewerProgram() {
        SandboxOutcome outcome = roundTrip(SandboxOutcome.class, "{\"errors\": [], \"values\": {}, \"newerThing\": {\"a\": [1]}}");
        assertThat(outcome.extra()).containsOnlyKeys("newerThing");
    }

    @Test
    void anOutcomeWithOnlyErrorsWritesNoOptionalMembers() {
        SandboxOutcome outcome = roundTrip(SandboxOutcome.class, "{\"errors\": []}");
        assertThat(outcome.values()).isNull();
        assertThat(MAPPER.valueToTree(outcome).propertyNames()).containsExactly("errors");
    }

    // ---------------------------------------------------------------- inspect

    @Test
    void inspectRequest() {
        JsonNode definition = RepoFixtures.json("packages/conformance-suite/fixtures/endpoint-fixture.definition.json");
        JsonNode request = MAPPER.createObjectNode().put("abi", "1.0.0").put("op", "check").put("formulaErrors", "warn")
            .put("riskyPatterns", "allow").set("definition", definition);
        ((tools.jackson.databind.node.ObjectNode) request).putArray("types").add("text").add("button");
        InspectRequest read = roundTrip(InspectRequest.class, request);
        assertThat(read.op()).isEqualTo("check");
        assertThat(read.types()).containsExactly("text", "button");
    }

    @Test
    void inspectAnswersAreChosenByOkAndOp() {
        JsonNode limits = MAPPER.readTree(KERNEL_LIMITS);
        assertThat(roundTrip(DefinitionLimits.class, limits).depth()).isEqualTo(32);

        InspectAnswer publicAnswer = roundTrip(InspectAnswer.class, "{\"ok\": true, \"op\": \"public\", \"definition\": {\"id\": \"f\", \"root\": {}}}");
        assertThat(publicAnswer).isInstanceOf(InspectPublicAnswer.class);

        InspectAnswer check = roundTrip(InspectAnswer.class, MAPPER.readTree("""
            {"ok": true, "op": "check",
             "problems": [{"where": "a.visibleWhen", "code": "parse", "message": "m", "params": {"n": 1}, "start": 0, "end": 3, "text": "a b"}],
             "warnings": [{"where": "b", "code": "condition.notBoolean", "severity": "warning", "message": "w", "params": {"key": "visibleWhen"}}],
             "policy": "fail",
             "structure": [{"code": "component.tooMany", "where": "root", "limit": 10000}],
             "structureWarnings": [{"code": "component.type.unknown", "where": "x", "message": "m"}],
             "limits": %s, "verdict": "fail"}
            """.formatted(limits)));
        assertThat(check).isInstanceOfSatisfying(InspectCheckAnswer.class, c -> {
            assertThat(c.verdict()).isEqualTo("fail");
            assertThat(c.problems().get(0).code()).isEqualTo("parse");
            assertThat(c.limits().components()).isEqualTo(10000);
            assertThat(c.ok()).isTrue();
        });

        InspectAnswer inventory = roundTrip(InspectAnswer.class, """
            {"ok": true, "op": "inspect",
             "rules": [{"componentId": "a", "key": "visibleWhen", "run": "both", "reads": ["b"], "readsHost": false, "readsClock": true, "functions": ["today"]}],
             "functionsUsed": ["today"], "pluginsNeeded": [],
             "paths": [{"path": "items.sku", "componentId": "sku", "type": "text", "holdsData": true,
                        "source": {"id": "s", "free": false}, "collection": {"collectionPath": "items"}}]}
            """);
        assertThat(inventory).isInstanceOf(InspectInventoryAnswer.class);

        InspectAnswer failure = roundTrip(InspectAnswer.class, "{\"ok\": false, \"error\": {\"code\": \"definition.tooDeep\", \"message\": \"m\", \"where\": \"w\", \"limit\": 32}}");
        assertThat(failure).isInstanceOfSatisfying(InspectFailure.class, f -> {
            assertThat(f.error().code()).isEqualTo("definition.tooDeep");
            assertThat(f.ok()).isFalse();
        });
    }

    // ---------------------------------------------------------------- pdf

    private static final String FONTS = "\"fonts\": [{\"id\": \"dejavu\", \"family\": \"DejaVu Sans\", \"weight\": 400, \"style\": \"normal\", \"data\": \"AAEC\", \"coverage\": [\"latin\"]}]";
    private static final String ENV = "\"env\": {\"createdAt\": \"2026-10-15T00:00:00.000Z\", \"documentId\": \"abc\", \"producer\": \"p\"}";
    private static final String SIGNATURE = "{\"certificates\": [\"MIIB\"], \"subFilter\": \"ETSI.CAdES.detached\", \"certify\": \"noChanges\", \"appearance\": false,"
        + " \"timestamp\": true, \"commitment\": {\"type\": \"approval\", \"statement\": \"s\"}, \"placeholderBytes\": 16384, \"name\": \"n\"}";

    private static String pdfRequest(String op) {
        JsonNode document = RepoFixtures.json("packages/pdf-kernel/tests/fixtures/documents-3.8/datum-pdf.json");
        JsonNode form = RepoFixtures.json("packages/conformance-suite/fixtures/endpoint-fixture.definition.json").get("root");
        String inputs = "\"form\": " + form + ", \"values\": {\"name\": \"Ada\"}, \"locale\": \"en\", \"layoutId\": \"main\","
            + " \"optionSnapshot\": {\"s\": [{\"value\": \"a\", \"label\": {\"en\": \"A\"}}]}, \"effectiveStates\": {\"a\": {\"visible\": true}},"
            + " \"unknownComponents\": \"warn\", \"today\": \"2026-10-15\", \"formulaErrors\": \"fail\", \"riskyPatterns\": \"refuse\","
            + " \"title\": \"T\", \"hostContext\": {\"k\": 1}, \"attachments\": {\"mode\": \"skip\"}, \"theme\": {}, \"translations\": {}, \"formTranslations\": {}";
        return switch (op) {
            case "capabilities" -> "{\"abi\": \"1.0.0\", \"op\": \"capabilities\"}";
            case "document" -> "{\"abi\": \"1.0.0\", \"op\": \"document\", " + FONTS + ", " + ENV + ", \"options\": {\"compact\": true, \"tagged\": true, \"pdfa\": {\"level\": \"2b\"}},"
                + " \"template\": {\"data\": \"AAEC\"}, \"signature\": " + SIGNATURE + ", " + inputs + "}";
            case "build" -> "{\"abi\": \"1.0.0\", \"op\": \"build\", " + inputs + "}";
            case "render" -> "{\"abi\": \"1.0.0\", \"op\": \"render\", \"document\": " + document + ", " + FONTS + ", " + ENV + ", \"options\": {\"pdfa\": false}, \"signature\": " + SIGNATURE + "}";
            case "layout" -> "{\"abi\": \"1.0.0\", \"op\": \"layout\", \"document\": " + document + ", " + FONTS + ", " + ENV + "}";
            case "fill" -> "{\"abi\": \"1.0.0\", \"op\": \"fill\", \"template\": {\"data\": \"AAEC\"}, \"values\": {\"f\": \"v\", \"c\": true, \"l\": [\"a\"]},"
                + " \"areas\": [{\"id\": \"a1\"}], " + FONTS + ", " + ENV + ", \"options\": {\"flatten\": false}, \"conformance\": {\"pdfa\": {\"level\": \"2b\"}},"
                + " \"attachments\": [{\"name\": \"x\"}], \"signature\": " + SIGNATURE + ", \"typography\": {}, \"colors\": {}}";
            case "inspect" -> "{\"abi\": \"1.0.0\", \"op\": \"inspect\", \"template\": {\"data\": \"AAEC\"}, \"attachments\": \"digest\"}";
            case "sign" -> "{\"abi\": \"1.0.0\", \"op\": \"sign\", \"pdf\": {\"data\": \"AAEC\"}, \"signature\": " + SIGNATURE + ", " + FONTS + ", " + ENV + "}";
            case "complete" -> "{\"abi\": \"1.0.0\", \"op\": \"complete\", \"pdf\": {\"data\": \"AAEC\"}, \"signing\": {\"certificates\": [\"MIIB\"], \"value\": \"c2ln\","
                + " \"toBeSignedDigest\": \"ab\", \"timestamp\": {\"token\": \"dG9r\"}, \"field\": \"Sig1\", \"required\": true}}";
            case "timestampRequest" -> "{\"abi\": \"1.0.0\", \"op\": \"timestampRequest\", \"signature\": \"c2ln\"}";
            case "verify" -> "{\"abi\": \"1.0.0\", \"op\": \"verify\", \"pdf\": {\"data\": \"AAEC\"}, \"knownCertificates\": [\"MIIB\"]}";
            default -> throw new IllegalArgumentException(op);
        };
    }

    @Test
    void everyPdfRequestOpRoundTripsAsItsOwnRecord() {
        Map<String, Class<? extends PdfRequest>> ops = Map.ofEntries(
            Map.entry("capabilities", PdfCapabilitiesRequest.class), Map.entry("document", PdfDocumentRequest.class),
            Map.entry("build", PdfBuildRequest.class), Map.entry("render", PdfRenderRequest.class), Map.entry("layout", PdfLayoutRequest.class),
            Map.entry("fill", PdfFillRequest.class), Map.entry("inspect", PdfInspectRequest.class), Map.entry("sign", PdfSignRequest.class),
            Map.entry("complete", PdfCompleteRequest.class), Map.entry("timestampRequest", PdfTimestampRequestRequest.class),
            Map.entry("verify", PdfVerifyRequest.class));
        assertThat(ops).hasSize(11);
        ops.forEach((op, type) -> {
            PdfRequest read = roundTrip(PdfRequest.class, pdfRequest(op));
            assertThat(read).isInstanceOf(type);
            assertThat(read.abi()).isEqualTo("1.0.0");
        });
    }

    @Test
    void aDocumentRequestNamesTheDefinitionsOwnTranslations() {
        // `formTranslations` is a member of its own, beside the host catalog's `translations`.
        PdfDocumentRequest read = (PdfDocumentRequest) roundTrip(PdfRequest.class, pdfRequest("document").replace("\"formTranslations\": {}", "\"formTranslations\": {\"fr\": {}}"));
        assertThat(read.formTranslations().has("fr")).isTrue();
        assertThat(read.extra()).doesNotContainKey("formTranslations");
    }

    @Test
    void aPdfRequestKeepsItsUnknownMembersAndNestedShapes() {
        PdfRequest read = roundTrip(PdfRequest.class, pdfRequest("complete").replace("\"abi\"", "\"newer\": {\"x\": 1}, \"abi\""));
        assertThat(((PdfCompleteRequest) read).extra()).containsKey("newer");
        assertThat(((PdfCompleteRequest) read).signing().timestamp().token()).isEqualTo("dG9r");
    }

    @Test
    void pdfFailureAndEveryOkReply() {
        PdfResponse failure = roundTrip(PdfResponse.class, "{\"ok\": false, \"error\": {\"code\": \"abi_mismatch\", \"message\": \"m\"}}");
        assertThat(failure).isInstanceOfSatisfying(PdfFailure.class, f -> assertThat(f.error().code()).isEqualTo("abi_mismatch"));

        String produced = "\"bytes\": \"JVBERg==\", \"pageCount\": 2, \"pages\": [{\"index\": 0, \"width\": 612, \"height\": 792, \"blockIds\": [\"b\"]}],"
            + " \"warnings\": [{\"code\": \"w\", \"message\": \"m\", \"componentId\": \"c\"}],"
            + " \"fields\": [{\"pdfField\": \"f\", \"status\": \"filled\", \"kind\": \"text\"}], \"areas\": [{\"id\": \"a\", \"page\": 0, \"status\": \"overflow\"}],"
            + " \"pdfa\": {\"level\": \"2b\"}, \"attachments\": [\"a.json\"],"
            + " \"signing\": {\"field\": \"Sig1\", \"byteRange\": [0, 10, 20, 30], \"digest\": \"d\", \"toBeSigned\": \"t\", \"toBeSignedDigest\": \"td\","
            + " \"signatureAlgorithm\": \"ECDSA-P256-SHA256\", \"subFilter\": \"ETSI.CAdES.detached\"}";
        Map<String, Class<? extends PdfResponse>> replies = Map.ofEntries(
            Map.entry("{\"ok\": true, \"op\": \"capabilities\", \"abi\": \"1.0.0\", \"kernelVersion\": \"1\"}", PdfCapabilitiesResponse.class),
            Map.entry("{\"ok\": true, \"op\": \"document\", " + produced + ", \"layoutId\": \"l\", \"layoutKind\": \"derived\", \"layoutChoice\": {\"id\": \"l\"}}", PdfDocumentResponse.class),
            Map.entry("{\"ok\": true, \"op\": \"render\", " + produced + "}", PdfRenderResponse.class),
            Map.entry("{\"ok\": true, \"op\": \"build\", \"layoutId\": \"l\", \"layoutKind\": \"generated\", \"document\": {\"version\": \"1\"}, \"fill\": {\"values\": {}}, \"warnings\": []}", PdfBuildResponse.class),
            Map.entry("{\"ok\": true, \"op\": \"layout\", \"pages\": [{\"index\": 0, \"width\": 612.5, \"height\": 792, \"blockIds\": []}], \"warnings\": []}", PdfLayoutResponse.class),
            Map.entry("{\"ok\": true, \"op\": \"fill\", \"bytes\": \"AA==\", \"pageCount\": 1, \"fields\": [], \"warnings\": [], \"attachments\": []}", PdfFillResponse.class),
            Map.entry("{\"ok\": true, \"op\": \"inspect\", \"info\": {\"pageCount\": 1, \"pages\": [{\"index\": 0, \"width\": 612, \"height\": 792}],"
                + " \"fields\": [{\"name\": \"f\", \"kind\": \"checkbox\", \"readOnly\": false, \"required\": true, \"value\": true, \"rect\": {\"x\": 1, \"y\": 2, \"width\": 3, \"height\": 4}, \"exportValues\": [\"Yes\"]}],"
                + " \"hasXfa\": false, \"encrypted\": true, \"permissions\": {\"print\": true}, \"signatures\": 0}}", PdfInspectResponse.class),
            Map.entry("{\"ok\": true, \"op\": \"sign\", \"bytes\": \"AA==\", \"signing\": {\"field\": \"S\", \"byteRange\": [0, 1, 2, 3], \"digest\": \"d\","
                + " \"toBeSigned\": \"t\", \"toBeSignedDigest\": \"td\", \"signatureAlgorithm\": \"RSASSA-PKCS1-v1_5-SHA256\", \"subFilter\": \"adbe.pkcs7.detached\"}, \"warnings\": []}", PdfSignResponse.class),
            Map.entry("{\"ok\": true, \"op\": \"complete\", \"bytes\": \"AA==\", \"field\": \"S\", \"cms\": \"Y21z\", \"timestamped\": true}", PdfCompleteResponse.class),
            Map.entry("{\"ok\": true, \"op\": \"timestampRequest\", \"request\": \"cmVx\"}", PdfTimestampRequestResponse.class),
            Map.entry(verifyReply(), PdfVerifyResponse.class));
        replies.forEach((json, type) -> assertThat(roundTrip(PdfResponse.class, json)).isInstanceOf(type));
    }

    private static String verifyReply() {
        return """
            {"ok": true, "op": "verify", "documentId": null,
             "signatures": [{"field": "Sig1", "subFilter": "ETSI.CAdES.detached", "byteRange": [0, 1, 2, 3], "coversDocument": true,
                "digestMatches": true, "certificateMatches": true,
                "signer": {"certificate": "MIIB", "publicKey": "MFk", "subject": "CN=a", "issuer": "CN=b", "serialNumber": "01",
                           "notBefore": "2026-01-01T00:00:00Z", "notAfter": "2027-01-01T00:00:00Z"},
                "signerSource": "signature", "certificates": ["MIIB"], "signatureAlgorithm": "ECDSA-P256-SHA256",
                "toBeVerified": "x", "signature": "y", "signingTime": null, "certification": {"permissions": "noChanges"},
                "timestamp": {"time": "2026-10-15T00:00:00Z", "coversSignature": true, "accuracy": {"seconds": 1}, "signer": null,
                              "signerSource": "token", "messageDigestMatches": true},
                "commitment": {"type": "approval", "statement": "s"}, "details": "signed",
                "signedRevision": {"reason": "r", "signingTime": null, "certification": null},
                "changedAfter": {"reason": null}, "laterRevisions": {"revisions": 1, "permitted": null,
                  "changes": [{"ref": "5 0", "kind": "field-value", "detail": "d"}],
                  "reliedOnSignatures": [{"field": "Sig1", "byteRange": [0, 1, 2, 3]}]}, "signedDocumentId": null}],
             "attachments": [{"name": "submission.json", "sha256": "ab", "relationship": "Data", "size": 12}], "warnings": []}
            """;
    }

    // ---------------------------------------------------------------- submissions

    @Test
    void passkeySignedEnvelopesFromTheEngineRoundTrip() {
        JsonNode fixture = RepoFixtures.fixture("webauthn-engine.json");
        int seen = 0;
        for (JsonNode credential : fixture.get("credentials")) {
            for (JsonNode doc : credential.get("documents")) {
                SubmissionEnvelope envelope = roundTrip(SubmissionEnvelope.class, doc.get("document"));
                SignatureResult signature = envelope.signatures().get(0);
                assertThat(signature.webauthn().credentialId()).isNotBlank();
                assertThat(signature.format().canonicalization()).isEqualTo("jcs");
                assertThat(signature.signedAt()).isPositive();
                assertThat(envelope.submission().values().get("fullName").stringValue()).isEqualTo("Zoë Ångström");
                seen++;
            }
        }
        assertThat(seen).isEqualTo(6);
    }

    @Test
    void theWrapperPlacementFromTheCanonicalFixture() {
        JsonNode cases = RepoFixtures.fixture("canonical.json");
        JsonNode wrapper = null;
        for (JsonNode c : cases) {
            if ("wrapper".equals(c.get("name").stringValue())) {
                wrapper = MAPPER.readTree(c.get("input").stringValue());
            }
        }
        SignedSubmissionDocument document = roundTrip(SignedSubmissionDocument.class, wrapper);
        assertThat(document.format().placement()).isEqualTo("wrapper");
        assertThat(document.payload().get("submission").get("locale").stringValue()).isEqualTo("en");
        assertThat(document.signatures()).hasSize(1);
        assertThat(document.signatures().get(0).extra()).containsKey("provider");
    }

    @Test
    void envelopeScalarsKeepTheirTypesAndNulls() {
        String json = """
            {"versionContext": {"form": {"id": 5, "version": null}}, "submission": {"locale": "en", "values": {}},
             "signatures": [{"signature": "s", "algorithm": "a", "signedAt": 1700000000000, "participantId": null,
               "webauthn": {"algorithm": -7}}]}
            """;
        roundTrip(SubmissionEnvelope.class, json);
        // A float where a whole number belongs is refused, not truncated.
        assertThatThrownBy(() -> MAPPER.readValue("{\"signature\": \"s\", \"signedAt\": 1700000000000.9}", SignatureResult.class))
            .isInstanceOf(RuntimeException.class);
    }

    @Test
    void sandboxPolicyRefusesAmbientAuthorityAndContextDropsBrowserOnlyKeys() {
        assertThatThrownBy(() -> MAPPER.readValue("{\"allowNetwork\": true}", SandboxPolicy.class)).isInstanceOf(RuntimeException.class);
        SandboxContext context = MAPPER.readValue("{\"formId\": \"f\", \"requiredComponents\": [], \"log\": 1, \"kept\": 2}", SandboxContext.class);
        assertThat(context.extra()).containsOnlyKeys("kept");
    }

    @Test
    void anEnvelopeWithServerVersionsAndAJourney() {
        SubmissionEnvelope envelope = roundTrip(SubmissionEnvelope.class, """
            {"versionContext": {"form": {"id": "f", "version": "2"},
               "client": {"runtimeVersion": "1", "rendererVersion": "1", "schemaVersion": "1", "components": {"text": "1.0.0"}, "plugins": {"p": "2"}},
               "server": {"runtimeVersion": "1", "validatorVersion": "2.14.0", "components": {}, "plugins": {}}},
             "submission": {"locale": "en", "values": {"a": null}, "journey": {"id": "j"}}}
            """);
        assertThat(envelope.submission().journey().id()).isEqualTo("j");
        assertThat(envelope.versionContext().server().validatorVersion()).isEqualTo("2.14.0");
    }

    @Test
    void webAuthnAssertionKeepsANullUserHandle() {
        WebAuthnAssertion assertion = roundTrip(WebAuthnAssertion.class, """
            {"credentialId": "c", "authenticatorData": "a", "clientDataJSON": "d", "signature": "s", "userHandle": null,
             "publicKey": "k", "algorithm": -7, "rpId": "localhost", "origin": "http://localhost", "signedAt": "2026-10-15T00:00:00.000Z"}
            """);
        assertThat(assertion.algorithm()).isEqualTo(-7);
        assertThat(assertion.userHandle().isNull()).isTrue();
    }

    @Test
    void theHttpBodiesLeaveANullFieldOut() {
        ErrorsBody errors = roundTrip(ErrorsBody.class, "{\"errors\": [{\"code\": \"required\"}, {\"field\": \"name\", \"code\": \"x\"}]}");
        assertThat(errors.errors().get(0).field()).isNull();
        ValidationBody body = roundTrip(ValidationBody.class, """
            {"accepted": false, "errors": [{"field": null, "code": "c", "severity": "warning"}, {"field": "a", "code": "b"}],
             "journey": {"pages": ["p"], "end": "end"}}
            """);
        assertThat(body.journey().pages()).isEqualTo(List.of("p"));
    }
}
