package com.argusvane.datum.pdf;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.core.DatumEventPublisher;
import com.argusvane.datum.core.ProgramUnavailableException;
import com.argusvane.datum.core.RequestTooLargeException;
import com.argusvane.datum.core.contracts.PdfCapabilitiesResponse;
import com.argusvane.datum.sandbox.wasi.EngineInfo;
import com.argusvane.datum.sandbox.protocol.HostOptions;
import com.argusvane.datum.sandbox.protocol.PdfAbi;
import com.argusvane.datum.sandbox.protocol.PdfProgram;
import com.argusvane.datum.sandbox.protocol.RunSlots;
import com.argusvane.datum.sandbox.protocol.SandboxException;
import com.argusvane.datum.pdf.verify.PdfVerification;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * The request assembly, the ABI and op, the fonts, env and formula inputs, the customizers, the refusals, as
 * {@link PdfService} makes them, against the kernel's reply shapes.
 */
class PdfServiceTest {

    private static final Clock CLOCK = Clock.fixed(Instant.parse("2026-10-15T09:08:07.654Z"), ZoneOffset.UTC);

    static ObjectNode definition(String json) {
        return (ObjectNode) TestAssets.JSON.readTree(json);
    }

    static final String FORM = "{\"id\":\"intake\",\"version\":\"1\",\"root\":{\"id\":\"root\",\"type\":\"form\",\"configuration\":{},"
        + "\"children\":{\"content\":[{\"id\":\"name\",\"type\":\"text\",\"configuration\":{\"label\":\"Name\"}}]}}}";

    static ObjectNode values() {
        return (ObjectNode) TestAssets.JSON.readTree("{\"name\":\"Ada\"}");
    }

    private static PdfService service(ScriptedPdfRuntime runtime) {
        return PdfService.builder().runtime(runtime.pdfRuntime()).clock(CLOCK).build();
    }

    @Test
    void everyRequestNamesTheHostAbiAndItsOpWhateverTheCallerSaid() {
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
        PdfService pdf = service(runtime);
        ObjectNode request = definition("{\"abi\":\"9.9.9\",\"op\":\"verify\",\"form\":{\"id\":\"root\",\"type\":\"form\"},\"values\":{},\"locale\":\"en\"}");
        pdf.document(request, PdfOptions.defaults());
        ObjectNode sent = runtime.requests("document").get(0);
        assertThat(sent.path("abi").asString()).isEqualTo(PdfAbi.MIN);
        assertThat(sent.path("op").asString()).isEqualTo("document");
        assertThat(request.path("abi").asString()).as("the caller's request is not changed").isEqualTo("9.9.9");
    }

    private static final com.argusvane.datum.core.assets.AssetManifest MANIFEST = new com.argusvane.datum.core.assets.AssetManifest(
        "b1", null, "0.1.0", null, null, null,
        List.of(new com.argusvane.datum.core.assets.AssetManifest.Binding("datum", "Datum", "datum-pdf")), null, null, null, null);

    private static com.argusvane.datum.core.assets.HostBindings twoRoutes() {
        JsonNode ledger = TestAssets.JSON.readTree("{\"id\":\"ledger\",\"version\":\"1.0.0\",\"target\":\"pdf\",\"label\":\"Ledger\"}");
        return com.argusvane.datum.core.assets.HostBindings.of(MANIFEST, "datum", Map.of("benefits", "ledger-binding"),
            List.of(new com.argusvane.datum.core.assets.AssetManifest.Binding("ledger-binding", "Ledger", "ledger")), Map.of("ledger", ledger));
    }

    @Test
    void aFormsBindingSuggestsThePdfThemeItsRequestCarriesAsTheHostTheme() {
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
        PdfService pdf = PdfService.builder().runtime(runtime.pdfRuntime()).clock(CLOCK).bindings(twoRoutes()).build();
        pdf.renderSubmission(definition(FORM), values(), "en", null, PdfOptions.defaults().withFormKey("benefits"));
        pdf.renderSubmission(definition(FORM), values(), "en", null, PdfOptions.defaults().withFormKey("contact"));
        pdf.renderSubmission(definition(FORM), values(), "en", null, PdfOptions.defaults());
        List<ObjectNode> sent = runtime.requests("document");
        assertThat(sent.get(0).path("theme").path("id").asString()).as("the route with an override").isEqualTo("ledger");
        assertThat(sent.get(1).has("theme")).as("the engine's own PDF look needs no theme").isFalse();
        assertThat(sent.get(2).has("theme")).as("no form, no route").isFalse();
        assertThat(pdf.pdfThemeId("benefits")).isEqualTo("ledger");
        assertThat(pdf.pdfThemeId("contact")).isEqualTo("datum-pdf");
    }

    @Test
    void aRequestThatNamesATheme_keepsIt_andNothingIsWrittenIntoTheLayout() {
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
        PdfService pdf = PdfService.builder().runtime(runtime.pdfRuntime()).clock(CLOCK).bindings(twoRoutes()).build();
        ObjectNode request = definition("{\"form\":{\"id\":\"root\",\"type\":\"form\"},\"values\":{},\"locale\":\"en\",\"theme\":{\"id\":\"mine\",\"target\":\"pdf\"}}");
        pdf.document(request, PdfOptions.defaults().withFormKey("benefits"));
        JsonNode sent = runtime.requests("document").get(0);
        assertThat(sent.path("theme").path("id").asString()).isEqualTo("mine");
        pdf.renderSubmission(definition(FORM), values(), "en", null, PdfOptions.defaults().withFormKey("benefits"));
        JsonNode printed = runtime.requests("document").get(1);
        assertThat(printed.path("pdf").isMissingNode()).as("no layout is derived or edited").isTrue();
    }

    @Test
    void aServiceWithoutBindingsSendsNoTheme() {
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
        service(runtime).renderSubmission(definition(FORM), values(), "en", null, PdfOptions.defaults().withFormKey("benefits"));
        assertThat(runtime.requests("document").get(0).has("theme")).isFalse();
    }

    @Test
    void theDefaultPackIsSansAndBoldWithTheirCoverageAndTheRealFonts() {
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
        service(runtime).renderSubmission(definition(FORM), values(), "en", null, PdfOptions.defaults());
        JsonNode fonts = runtime.requests("document").get(0).get("fonts");
        assertThat(fonts).hasSize(2);
        assertThat(fonts.get(0).path("id").asString()).isEqualTo("dejavu-sans");
        assertThat(fonts.get(1).path("id").asString()).isEqualTo("dejavu-sans-bold");
        assertThat(fonts.get(1).path("weight").asInt()).isEqualTo(700);
        assertThat(fonts.get(0).path("coverage").toString()).isEqualTo("[\"Latn\",\"Grek\",\"Cyrl\",\"Arab\",\"Hebr\"]");
        byte[] data = Base64.getDecoder().decode(fonts.get(0).path("data").asString());
        assertThat(data.length).isGreaterThan(100_000);
        // TrueType: version 1.0.
        assertThat(new byte[] {data[0], data[1], data[2], data[3]}).containsExactly(0, 1, 0, 0);
    }

    @Test
    void theStandardPackIsFiveFacesAndAllIsTheParityOrder() {
        PdfFonts fonts = PdfFonts.fromClasspath(null);
        assertThat(fonts.missing()).isEmpty();
        assertThat(ids(fonts.pack(PdfFonts.Pack.STANDARD))).containsExactly("dejavu-sans", "dejavu-sans-bold", "dejavu-sans-oblique", "dejavu-mono",
            "dejavu-mono-bold");
        // The order of the kernel's font loader, as datum-sandbox-endive's PdfRenderIT renders the parity documents.
        assertThat(ids(fonts.pack(PdfFonts.Pack.ALL))).containsExactly("dejavu-sans", "dejavu-sans-bold", "dejavu-sans-oblique", "dejavu-serif",
            "dejavu-serif-bold", "dejavu-mono", "dejavu-mono-bold");
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
        PdfService pdf = PdfService.builder().runtime(runtime.pdfRuntime()).defaultFonts(PdfFonts.Pack.STANDARD).build();
        pdf.renderSubmission(definition(FORM), values(), "en", null, PdfOptions.defaults());
        pdf.renderSubmission(definition(FORM), values(), "en", null, PdfOptions.defaults().withFonts(PdfFonts.Pack.ALL));
        assertThat(runtime.requests("document").get(0).get("fonts")).hasSize(5);
        assertThat(runtime.requests("document").get(1).get("fonts")).hasSize(7);
    }

    private static List<String> ids(JsonNode fonts) {
        List<String> out = new ArrayList<>();
        fonts.values().forEach(font -> out.add(font.path("id").asString()));
        return out;
    }

    @Test
    void aFontTheJarLacksIsLeftOut() {
        PdfFonts fonts = new PdfFonts(name -> name.endsWith("DejaVuSans-Bold.ttf") ? null : PdfServiceTest.class.getClassLoader().getResourceAsStream(name));
        assertThat(fonts.missing()).containsExactly("DejaVuSans-Bold.ttf");
        assertThat(ids(fonts.pack(PdfFonts.Pack.DEFAULT))).containsExactly("dejavu-sans");
    }

    @Test
    void envIsNowAtWholeSecondsAndARandomDocumentIdUnlessGiven() {
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
        PdfService pdf = service(runtime);
        pdf.document(definition("{\"form\":{\"id\":\"root\",\"type\":\"form\"},\"values\":{},\"locale\":\"en\"}"), PdfOptions.defaults());
        JsonNode env = runtime.requests("document").get(0).get("env");
        assertThat(env.path("createdAt").asString()).isEqualTo("2026-10-15T09:08:07.000Z");
        assertThat(env.path("documentId").asString()).matches("^[0-9a-f]{32}$");
        assertThat(env.has("producer")).as("a raw document request has no producer: only a submission's PDF names this host").isFalse();

        pdf.renderSubmission(definition(FORM), values(), "fr", null,
            PdfOptions.defaults().withDocument("6f1c2c1e-submission", Instant.parse("2026-01-02T03:04:05.999Z")));
        JsonNode submission = runtime.requests("document").get(1);
        assertThat(submission.path("env").path("createdAt").asString()).isEqualTo("2026-01-02T03:04:05.000Z");
        assertThat(submission.path("env").path("documentId").asString()).isEqualTo("6f1c2c1e-submission");
        assertThat(submission.path("env").path("producer").asString()).isEqualTo(PdfService.PRODUCER);
        assertThat(submission.path("locale").asString()).isEqualTo("fr");
        assertThat(submission.path("form").path("id").asString()).isEqualTo("root");
        assertThat(submission.path("values").path("name").asString()).isEqualTo("Ada");
    }

    @Test
    void theFormulaInputsGoWithEveryDocumentAndKeepTheCallersDay() {
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
        PdfService pdf = service(runtime);
        ObjectNode request = definition("{\"form\":{\"id\":\"root\",\"type\":\"form\"},\"values\":{},\"locale\":\"en\",\"today\":\"2026-01-01\"}");
        pdf.document(request, PdfOptions.defaults());
        JsonNode sent = runtime.requests("document").get(0);
        assertThat(sent.path("today").asString()).isEqualTo("2026-01-01");
        assertThat(sent.path("formulaErrors").asString()).isEqualTo("fail");
        assertThat(sent.path("riskyPatterns").asString()).isEqualTo("refuse");
    }

    @Test
    void renderOptionsAreMergedOverTheRequestsOwn() {
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
        ObjectNode request = definition("{\"form\":{\"id\":\"root\",\"type\":\"form\"},\"values\":{},\"locale\":\"en\",\"options\":{\"compact\":false,\"tagged\":true}}");
        service(runtime).document(request, PdfOptions.defaults().withRenderOptions(true, null, TestAssets.JSON.readTree("false")));
        JsonNode options = runtime.requests("document").get(0).path("options");
        assertThat(options.path("compact").asBoolean()).isTrue();
        assertThat(options.path("tagged").asBoolean()).isTrue();
        assertThat(options.path("pdfa").isBoolean()).isTrue();
        assertThat(options.path("pdfa").asBoolean()).isFalse();
    }

    @Test
    void customizersAdjustTheMembersTheOpCarriesAndNeverTheAbiOrOp() {
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
        List<String> seen = new ArrayList<>();
        PdfRequestCustomizer first = draft -> {
            seen.add(draft.op() + ":" + draft.formKey());
            ObjectNode env = (ObjectNode) draft.env().deepCopy();
            env.put("producer", "Permit office");
            draft.env(env);
            ObjectNode host = TestAssets.JSON.createObjectNode();
            host.put("office", "Ottawa");
            draft.hostContext(host);
        };
        PdfRequestCustomizer second = draft -> {
            // Sees what the first left.
            seen.add(draft.env().path("producer").asString());
            draft.fonts(null);
        };
        PdfService pdf = PdfService.builder().runtime(runtime.pdfRuntime()).customizers(List.of(first, second)).build();
        pdf.renderSubmission(definition(FORM), values(), "en", null, PdfOptions.defaults().withFormKey("intake"));
        JsonNode sent = runtime.requests("document").get(0);
        assertThat(seen).containsExactly("document:intake", "Permit office");
        assertThat(sent.path("env").path("producer").asString()).isEqualTo("Permit office");
        assertThat(sent.path("hostContext").path("office").asString()).isEqualTo("Ottawa");
        assertThat(sent.path("fonts")).as("a request whose fonts a customizer dropped still carries the host's").hasSize(2);
        assertThat(sent.path("abi").asString()).isEqualTo(PdfAbi.MIN);
        assertThat(sent.path("op").asString()).isEqualTo("document");
    }

    @Test
    void aCustomizerCannotSetAMemberTheOpDoesNotCarry() {
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
        PdfService pdf = PdfService.builder().runtime(runtime.pdfRuntime())
            .customizers(List.of(draft -> draft.env(TestAssets.JSON.createObjectNode()))).build();
        assertThatThrownBy(() -> pdf.build(definition("{\"form\":{\"id\":\"root\",\"type\":\"form\"},\"values\":{},\"locale\":\"en\"}"),
            PdfOptions.defaults())).isInstanceOf(IllegalArgumentException.class).hasMessageContaining("build request carries no env");
        assertThat(runtime.count("build")).isZero();
    }

    @Test
    void theOpsThatMakeNoDocumentAreNeverCustomized() {
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
        List<String> ops = new ArrayList<>();
        PdfService pdf = PdfService.builder().runtime(runtime.pdfRuntime()).customizers(List.of(draft -> ops.add(draft.op()))).build();
        pdf.inspect("%PDF-1.7".getBytes(StandardCharsets.US_ASCII), "digest");
        pdf.timestampRequest(new byte[] {1, 2, 3});
        pdf.verifyRaw("%PDF-1.7".getBytes(StandardCharsets.US_ASCII));
        assertThat(ops).isEmpty();
        assertThat(runtime.requests("inspect").get(0).path("attachments").asString()).isEqualTo("digest");
    }

    @Test
    void aBytecodeRunnerIsUnavailableBeforeAnySlotOrRun() {
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
        PdfService pdf = PdfService.builder().runtime(runtime.pdfRuntime("bytecode", 1)).build();
        assertThatThrownBy(() -> pdf.renderSubmission(definition(FORM), values(), "en", null, PdfOptions.defaults()))
            .isInstanceOf(PdfUnavailableException.class)
            .hasMessageContaining("JVM bytecode")
            .satisfies(e -> {
                assertThat(((PdfUnavailableException) e).code()).isEqualTo("server.unavailable");
                assertThat(((PdfUnavailableException) e).httpStatus()).isEqualTo(503);
            });
        assertThatThrownBy(pdf::capabilities).isInstanceOf(PdfUnavailableException.class);
        assertThat(runtime.requests()).isEmpty();
    }

    @Test
    void aRuntimeWithoutTheProgramIsUnavailable() {
        PdfRuntime down = new PdfRuntime() {
            @Override
            public PdfProgram program() {
                throw new ProgramUnavailableException("PDFs cannot be made right now: the runtime is DOWN.");
            }

            @Override
            public RunSlots slots() {
                return new RunSlots(1, java.time.Duration.ZERO, "PDF render");
            }

            @Override
            public EngineInfo engine() {
                return ScriptedPdfRuntime.engine("jffi");
            }

            @Override
            public Map<String, String> contextKeys() {
                return HostOptions.defaults().contextKeys();
            }

            @Override
            public int pdfSeconds() {
                return 15;
            }
        };
        PdfService pdf = PdfService.builder().runtime(down).build();
        assertThatThrownBy(() -> pdf.verifyRaw("%PDF-1.7".getBytes(StandardCharsets.US_ASCII)))
            .isInstanceOf(PdfUnavailableException.class).hasMessageContaining("DOWN");
    }

    @Test
    void theProgramsRefusalIsAPdfExceptionWithTheKernelsCodeAndTheHostsWords() {
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime()
            .on("document", body -> ScriptedPdfRuntime.failure("layout", "Layout \"copy\" has a block with no id <script>"));
        assertThatThrownBy(() -> service(runtime).renderSubmission(definition(FORM), values(), "en", null, PdfOptions.defaults()))
            .isInstanceOf(PdfException.class)
            .satisfies(e -> {
                PdfException refused = (PdfException) e;
                assertThat(refused.code()).isEqualTo("layout");
                assertThat(refused.kernelCode()).isEqualTo("layout");
                assertThat(refused.httpStatus()).isEqualTo(500);
                assertThat(refused.kernelMessage()).contains("no id");
                assertThat(refused.getMessage()).isEqualTo("The PDF program refused the request (layout).");
            });
    }

    @Test
    void anAnswerWithoutAPdfIsRefused() {
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime()
            .on("document", body -> "{\"ok\":true,\"op\":\"document\",\"bytes\":\"" + Base64.getEncoder().encodeToString("<html>".getBytes(StandardCharsets.US_ASCII))
                + "\",\"pageCount\":1,\"pages\":[],\"warnings\":[]}");
        assertThatThrownBy(() -> service(runtime).renderSubmission(definition(FORM), values(), "en", null, PdfOptions.defaults()))
            .isInstanceOf(PdfException.class).hasMessage("The PDF program answered without a PDF.")
            .satisfies(e -> assertThat(((PdfException) e).code()).isEqualTo("internal"));
        ScriptedPdfRuntime notBase64 = new ScriptedPdfRuntime()
            .on("document", body -> "{\"ok\":true,\"op\":\"document\",\"bytes\":\"%PDF-1.7 not base64\",\"pageCount\":1,\"pages\":[],\"warnings\":[]}");
        assertThatThrownBy(() -> service(notBase64).renderSubmission(definition(FORM), values(), "en", null, PdfOptions.defaults()))
            .isInstanceOf(PdfException.class).hasMessage("The PDF program answered without a PDF.");
    }

    @Test
    void everySlotTakenIsBusyAtOnce() {
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
        PdfRuntime pdfRuntime = runtime.pdfRuntime("jffi", 1);
        PdfService pdf = PdfService.builder().runtime(pdfRuntime).build();
        try (RunSlots.Permit held = pdfRuntime.slots().acquire()) {
            assertThatThrownBy(() -> pdf.renderSubmission(definition(FORM), values(), "en", null, PdfOptions.defaults()))
                .isInstanceOf(SandboxException.class)
                .satisfies(e -> {
                    assertThat(((SandboxException) e).code()).isEqualTo("server.busy");
                    assertThat(((SandboxException) e).httpStatus()).isEqualTo(503);
                });
        }
        assertThat(runtime.count("document")).isZero();
    }

    @Test
    void aLayoutTheDefinitionDoesNotDeclareIsNotFound() {
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
        PdfService pdf = service(runtime);
        assertThatThrownBy(() -> pdf.renderSubmission(definition(FORM), values(), "en", "copy", PdfOptions.defaults()))
            .isInstanceOf(PdfException.class)
            .satisfies(e -> {
                assertThat(((PdfException) e).code()).isEqualTo(PdfException.LAYOUT_NOT_FOUND);
                assertThat(((PdfException) e).httpStatus()).isEqualTo(404);
                // Fixed words: a 4xx never repeats what the caller sent.
                assertThat(e.getMessage()).isEqualTo("The form has no such PDF layout.");
            });
        // "default" names no layout unless one has that id: the program chooses.
        pdf.renderSubmission(definition(FORM), values(), "en", "default", PdfOptions.defaults());
        assertThat(runtime.requests("document").get(0).has("layoutId")).isFalse();
        ObjectNode withDefault = definition(FORM);
        withDefault.set("pdf", TestAssets.JSON.readTree("{\"layouts\":[{\"id\":\"default\",\"kind\":\"generated\"},{\"id\":\"copy\",\"kind\":\"generated\"}]}"));
        pdf.renderSubmission(withDefault, values(), "en", "default", PdfOptions.defaults());
        pdf.renderSubmission(withDefault, values(), "en", "copy", PdfOptions.defaults());
        assertThat(runtime.requests("document").get(1).path("layoutId").asString()).isEqualTo("default");
        assertThat(runtime.requests("document").get(2).path("layoutId").asString()).isEqualTo("copy");
        assertThat(runtime.requests("document").get(2).path("pdf").path("layouts")).hasSize(2);
    }

    @Test
    void translationsAndTheOptionSnapshotRideAlongWhenGiven() {
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
        ObjectNode catalog = (ObjectNode) TestAssets.JSON.readTree("{\"fr\":{\"components\":{\"name\":{\"label\":\"Nom\"}}}}");
        ObjectNode snapshot = (ObjectNode) TestAssets.JSON.readTree("{\"country\":[{\"value\":\"ca\",\"label\":\"Canada\"}]}");
        service(runtime).renderSubmission(definition(FORM), values(), "fr", null,
            PdfOptions.defaults().withTranslations(catalog).withOptionSnapshot(snapshot));
        JsonNode sent = runtime.requests("document").get(0);
        assertThat(sent.path("translations").path("fr").path("components").path("name").path("label").asString()).isEqualTo("Nom");
        assertThat(sent.path("optionSnapshot").path("country").get(0).path("label").asString()).isEqualTo("Canada");
        service(runtime).renderSubmission(definition(FORM), values(), "fr", null,
            PdfOptions.defaults().withTranslations(TestAssets.JSON.createObjectNode()).withOptionSnapshot(TestAssets.JSON.createObjectNode()));
        assertThat(runtime.requests("document").get(1).has("translations")).isFalse();
        assertThat(runtime.requests("document").get(1).has("optionSnapshot")).isFalse();
    }

    @Test
    void theDefinitionsOwnTranslationsRideAsFormTranslationsBesideTheHostCatalog() {
        // The program resolves a layout's and the form's texts from the definition's map; the host catalog
        // stays `translations`. A definition without a map sends neither member.
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
        ObjectNode catalog = (ObjectNode) TestAssets.JSON.readTree("{\"fr\":{\"form\":{\"title\":\"Hote\"}}}");
        ObjectNode withMap = definition(FORM);
        withMap.set("translations", TestAssets.JSON.readTree(
            "{\"fr\":{\"components\":{\"name\":{\"label\":{\"text\":\"Nom\",\"source\":\"abc\"}}},"
                + "\"pdf\":{\"copy\":{\"name\":{\"text\":\"Copie\",\"source\":\"def\"}}}}}"));
        service(runtime).renderSubmission(withMap, values(), "fr", null, PdfOptions.defaults().withTranslations(catalog));
        JsonNode sent = runtime.requests("document").get(0);
        assertThat(sent.path("translations").path("fr").path("form").path("title").asString()).isEqualTo("Hote");
        assertThat(sent.path("formTranslations").path("fr").path("components").path("name").path("label").path("text").asString()).isEqualTo("Nom");
        assertThat(sent.path("formTranslations").path("fr").path("pdf").path("copy").path("name").path("text").asString()).isEqualTo("Copie");

        service(runtime).renderSubmission(definition(FORM), values(), "fr", null, PdfOptions.defaults());
        assertThat(runtime.requests("document").get(1).has("formTranslations")).isFalse();
    }

    @Test
    void theResultCarriesTheLayoutTheWarningsAndTheRestOfTheAnswer() {
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime().on("document", body -> "{\"ok\":true,\"op\":\"document\",\"bytes\":\""
            + Base64.getEncoder().encodeToString("%PDF-1.7 x".getBytes(StandardCharsets.US_ASCII))
            + "\",\"pageCount\":3,\"pages\":[],\"warnings\":[{\"code\":\"field.overflow\",\"message\":\"clipped\",\"componentId\":\"name\"}],"
            + "\"fields\":[{\"pdfField\":\"Name\",\"status\":\"filled\"}],\"layoutId\":\"copy\",\"layoutKind\":\"template\",\"layoutChoice\":\"condition\"}");
        PdfResult result = service(runtime).document(definition("{\"form\":{\"id\":\"root\",\"type\":\"form\"},\"values\":{},\"locale\":\"en\"}"),
            PdfOptions.defaults());
        assertThat(new String(result.bytes(), StandardCharsets.US_ASCII)).isEqualTo("%PDF-1.7 x");
        assertThat(result.pageCount()).isEqualTo(3);
        assertThat(result.layoutId()).isEqualTo("copy");
        assertThat(result.layoutKind()).isEqualTo("template");
        assertThat(result.layoutChoice().asString()).isEqualTo("condition");
        assertThat(result.warnings()).hasSize(1);
        assertThat(result.warnings().get(0).path("componentId").asString()).isEqualTo("name");
        assertThat(result.answer().has("bytes")).isFalse();
        assertThat(result.answer().path("fields").get(0).path("status").asString()).isEqualTo("filled");
        assertThat(result.signed()).isFalse();
    }

    @Test
    void renderedEventsAreSentAndAListenerThatThrowsChangesNothing() {
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
        List<PdfRenderedEvent> events = new ArrayList<>();
        // Through the host's default publisher, which is the guarded one.
        PdfService pdf = PdfService.builder().runtime(runtime.pdfRuntime()).events(DatumEventPublisher.guarded(event -> {
            events.add((PdfRenderedEvent) event);
            throw new IllegalStateException("listener bug");
        })).build();
        PdfResult result = pdf.renderSubmission(definition(FORM), values(), "en", null, PdfOptions.defaults().withFormKey("intake"));
        assertThat(events).hasSize(1);
        assertThat(events.get(0).formKey()).isEqualTo("intake");
        assertThat(events.get(0).op()).isEqualTo("document");
        assertThat(events.get(0).layoutId()).isEqualTo("default");
        assertThat(events.get(0).signed()).isFalse();
        assertThat(events.get(0).bytes()).isEqualTo(result.bytes());
        pdf.render(TestAssets.JSON.createObjectNode(), PdfOptions.defaults());
        assertThat(events.get(1).op()).isEqualTo("render");
    }

    /** One guard for every event, with the submission's catch set, so a listener's assertion is logged too. */
    @Test
    void aRenderedListenerThatFailsAnAssertionChangesNothing() {
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
        List<Object> events = new ArrayList<>();
        PdfService pdf = PdfService.builder().runtime(runtime.pdfRuntime()).events(DatumEventPublisher.guarded(event -> {
            events.add(event);
            throw new AssertionError("a listener's invariant");
        })).build();
        PdfResult result = pdf.renderSubmission(definition(FORM), values(), "en", null, PdfOptions.defaults().withFormKey("intake"));
        assertThat(result.bytes()).isNotEmpty();
        assertThat(events).hasSize(1);
    }

    /**
     * The service uses the publisher it is given as given, so an application's own
     * publisher that throws (an outbox write that failed) reaches the caller after the PDF was made.
     */
    @Test
    void anApplicationsOwnPublisherThatThrowsReachesTheCaller() {
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
        List<Object> events = new ArrayList<>();
        PdfService pdf = PdfService.builder().runtime(runtime.pdfRuntime()).events(event -> {
            events.add(event);
            throw new IllegalStateException("outbox down");
        }).build();
        assertThatThrownBy(() -> pdf.renderSubmission(definition(FORM), values(), "en", null, PdfOptions.defaults().withFormKey("intake")))
            .isInstanceOf(IllegalStateException.class).hasMessage("outbox down");
        assertThat(events).singleElement().isInstanceOf(PdfRenderedEvent.class);
    }

    /**
     * A completed verification is published as {@link PdfVerifiedEvent}, so an audit log is a listener rather
     * than a {@code PdfVerifier} subclass. It carries what the report says (the hash, the placed signatures, the trust policy),
     * never the file; a refused file (too large, not a PDF) publishes nothing, and a listener that throws changes nothing.
     */
    @Test
    void aCompletedVerificationIsPublishedWithoutTheFile() {
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
        List<Object> events = new ArrayList<>();
        PdfService pdf = PdfService.builder().runtime(runtime.pdfRuntime()).verifyMaxBytes(1024 * 1024).events(DatumEventPublisher.guarded(event -> {
            events.add(event);
            throw new IllegalStateException("audit log down");
        })).build();
        assertThatThrownBy(() -> pdf.verify(new byte[1024 * 1024 + 1])).isInstanceOf(RequestTooLargeException.class);
        assertThatThrownBy(() -> pdf.verify("hello".getBytes(StandardCharsets.US_ASCII))).isInstanceOf(PdfException.class);
        assertThat(events).isEmpty();

        PdfVerification verification = pdf.verify("%PDF-1.7\n".getBytes(StandardCharsets.US_ASCII));

        assertThat(events).singleElement().isInstanceOfSatisfying(PdfVerifiedEvent.class, event -> {
            assertThat(event.sha256()).isEqualTo(verification.sha256());
            assertThat(event.size()).isEqualTo(verification.bytes());
            assertThat(event.documentId()).isEqualTo(verification.documentId());
            assertThat(event.signatures()).isEqualTo(verification.signatures());
            assertThat(event.trustPolicy()).isEqualTo(verification.trustPolicy());
        });
        assertThat(java.util.Arrays.stream(PdfVerifiedEvent.class.getRecordComponents()).map(c -> (Object) c.getType()))
            .as("the event carries no bytes").doesNotContain(byte[].class);
    }

    @Test
    void verifyRefusesTooLargeAndNotAPdfBeforeTheProgramRuns() {
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
        PdfService pdf = PdfService.builder().runtime(runtime.pdfRuntime()).verifyMaxBytes(1024 * 1024).build();
        assertThatThrownBy(() -> pdf.verify(new byte[1024 * 1024 + 1])).isInstanceOf(RequestTooLargeException.class)
            .satisfies(e -> assertThat(((RequestTooLargeException) e).httpStatus()).isEqualTo(413));
        assertThatThrownBy(() -> pdf.verify("hello".getBytes(StandardCharsets.US_ASCII))).isInstanceOf(PdfException.class)
            .hasMessageContaining("not a PDF")
            .satisfies(e -> assertThat(((PdfException) e).httpStatus()).isEqualTo(400));
        assertThat(runtime.requests()).isEmpty();
        // Leading whitespace is allowed (a reader finds the header in the first kilobyte).
        pdf.verify("\n \t%PDF-1.7\n".getBytes(StandardCharsets.US_ASCII));
        assertThat(runtime.count("verify")).isEqualTo(1);
    }

    @Test
    void theTimestampRequestAndInspectAnswersAreRead() {
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
        PdfService pdf = service(runtime);
        byte[] der = pdf.timestampRequest(new byte[] {9, 8, 7});
        assertThat(der[0]).isEqualTo((byte) 0x30);
        assertThat(pdf.inspect("%PDF-1.7".getBytes(StandardCharsets.US_ASCII), null).path("pageCount").asInt()).isEqualTo(1);
        assertThatThrownBy(() -> pdf.inspect(new byte[1], "everything")).isInstanceOf(IllegalArgumentException.class);
        ScriptedPdfRuntime empty = new ScriptedPdfRuntime().on("timestampRequest", body -> "{\"ok\":true,\"op\":\"timestampRequest\",\"request\":\"\"}");
        assertThatThrownBy(() -> service(empty).timestampRequest(new byte[] {1})).isInstanceOf(PdfException.class)
            .hasMessageContaining("without a timestamp request");
    }

    @Test
    void capabilitiesAreTheProgramsAbiAndKernelVersion() {
        PdfCapabilitiesResponse capabilities = service(new ScriptedPdfRuntime()).capabilities();
        assertThat(capabilities.abi()).isEqualTo(PdfAbi.MIN);
        assertThat(capabilities.kernelVersion()).isEqualTo("0.1.0");
    }

    @Test
    void knownCapabilitiesTakeNoSlotSoAProbeIsNeverBusyWhileEverySlotRenders() {
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
        PdfRuntime pdfRuntime = runtime.pdfRuntime("jffi", 2);
        PdfService pdf = PdfService.builder().runtime(pdfRuntime).build();
        // The first answer needs the program, so a slot: busy while every slot is held.
        try (RunSlots.Permit one = pdfRuntime.slots().acquire(); RunSlots.Permit two = pdfRuntime.slots().acquire()) {
            assertThatThrownBy(pdf::capabilities).isInstanceOf(SandboxException.class)
                .satisfies(e -> assertThat(((SandboxException) e).code()).isEqualTo("server.busy"));
        }
        assertThat(pdf.capabilities().abi()).isEqualTo(PdfAbi.MIN);
        try (RunSlots.Permit one = pdfRuntime.slots().acquire(); RunSlots.Permit two = pdfRuntime.slots().acquire()) {
            assertThat(pdf.capabilities().kernelVersion()).as("remembered: no slot").isEqualTo("0.1.0");
        }
        // A bytecode runner is still refused first, whatever is remembered.
        assertThatThrownBy(PdfService.builder().runtime(runtime.pdfRuntime("bytecode", 1)).build()::capabilities)
            .isInstanceOf(PdfUnavailableException.class);
    }

    @Test
    void aFileThatTheProgramRefusesToVerifyIsTheCallers400NotA500() {
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime()
            .on("verify", body -> ScriptedPdfRuntime.failure("signature", "An encrypted document's signatures cannot be read"));
        PdfService pdf = service(runtime);
        assertThatThrownBy(() -> pdf.verify("%PDF-1.7 encrypted".getBytes(StandardCharsets.US_ASCII)))
            .isInstanceOf(PdfException.class)
            .satisfies(e -> {
                PdfException refused = (PdfException) e;
                assertThat(refused.code()).isEqualTo(PdfException.UNREADABLE);
                assertThat(refused.httpStatus()).isEqualTo(400);
                assertThat(refused.kernelCode()).isEqualTo("signature");
                assertThat(refused.kernelMessage()).contains("encrypted");
                assertThat(refused.getMessage()).doesNotContain("encrypted");
            });
        ScriptedPdfRuntime junk = new ScriptedPdfRuntime().on("verify", body -> ScriptedPdfRuntime.failure("internal", "Error: Failed to parse"));
        assertThatThrownBy(() -> service(junk).verify("%PDF-1.7 junk".getBytes(StandardCharsets.US_ASCII)))
            .isInstanceOf(PdfException.class).satisfies(e -> assertThat(((PdfException) e).httpStatus()).isEqualTo(400));
        // An ABI mismatch is the server's fault, not the file's.
        ScriptedPdfRuntime stale = new ScriptedPdfRuntime().on("verify", body -> ScriptedPdfRuntime.failure("abi_mismatch", "0.1.0"));
        assertThatThrownBy(() -> service(stale).verify("%PDF-1.7".getBytes(StandardCharsets.US_ASCII)))
            .isInstanceOf(PdfException.class).satisfies(e -> assertThat(((PdfException) e).httpStatus()).isEqualTo(500));
        // verifyRaw stays the program's own answer, refusals as they are.
        assertThatThrownBy(() -> pdf.verifyRaw("%PDF-1.7".getBytes(StandardCharsets.US_ASCII)))
            .isInstanceOf(PdfException.class).satisfies(e -> assertThat(((PdfException) e).code()).isEqualTo("signature"));
    }

    @Test
    void renderPreparesASignatureOnlyWhenItIsGivenOne() {
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
        List<PdfRenderedEvent> events = new ArrayList<>();
        PdfService pdf = PdfService.builder().runtime(runtime.pdfRuntime()).events(event -> {
            if (event instanceof PdfRenderedEvent rendered) {
                events.add(rendered);
            }
        }).build();
        PdfResult plain = pdf.render(TestAssets.JSON.createObjectNode(), PdfOptions.defaults());
        assertThat(runtime.requests("render").get(0).has("signature")).isFalse();
        assertThat(plain.signing()).isNull();
        ObjectNode spec = TestAssets.JSON.createObjectNode();
        TestAssets.signer("p256").certificatesBase64().forEach(spec.putArray("certificates")::add);
        PdfResult prepared = pdf.render(TestAssets.JSON.createObjectNode(), spec, PdfOptions.defaults());
        assertThat(runtime.requests("render").get(1).path("signature").path("certificates")).hasSize(1);
        assertThat(prepared.signing()).isNotNull();
        assertThat(prepared.signing().signatureAlgorithm()).isEqualTo("ECDSA-P256-SHA256");
        assertThat(prepared.signed()).as("the server's key is never used by render").isFalse();
        assertThat(events).hasSize(1).allSatisfy(e -> assertThat(e.op()).isEqualTo("render"));
    }
}
