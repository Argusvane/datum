package com.argusvane.datum.ui.builder;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assertions.assertThrows;

import com.argusvane.datum.core.DatumException;
import com.argusvane.datum.core.ProgramUnavailableException;
import com.argusvane.datum.core.contracts.DatumJson;
import com.argusvane.datum.sandbox.protocol.SandboxService;
import com.argusvane.datum.forms.DefinitionService;
import com.argusvane.datum.forms.FormDefinitionRepository;
import com.argusvane.datum.forms.FormDefinitionSavedEvent;
import com.argusvane.datum.forms.FormNotFoundException;
import com.argusvane.datum.forms.snapshot.DefinitionSnapshotStore;
import com.argusvane.datum.forms.FormOutdatedException;
import com.argusvane.datum.forms.FormStoreReadOnlyException;
import com.argusvane.datum.forms.SavedForm;
import com.argusvane.datum.forms.snapshot.InMemoryDefinitionSnapshotStore;
import com.argusvane.datum.forms.translation.InMemoryTranslationCatalogStore;
import com.argusvane.datum.forms.translation.StoredCatalog;
import com.argusvane.datum.forms.translation.TranslationCatalog;
import com.argusvane.datum.forms.translation.TranslationCatalogStore;
import com.argusvane.datum.forms.web.FormsReply;
import com.argusvane.datum.web.error.ErrorMapper;
import com.argusvane.datum.web.error.ErrorResponse;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Supplier;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.function.Executable;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * The save decisions of {@link BuilderApi}: the kernel's verdict on a save (a save is checked by
 * the sandbox kernel), the host's own refusals (BLD-01 to BLD-07) and the refusal order. The whole real
 * path runs: {@code DefinitionService.check} through {@code SandboxService} into {@link KernelStub}, which answers
 * the risky-pattern and duplicate-id definitions with the real kernel's captured answers. Errors are read through
 * the real {@link ErrorMapper}, so the bodies asserted are the ones a client gets.
 */
class BuilderApiTest {

    /** The assets manifest's knownComponentTypes. */
    static final List<String> TYPES = List.of("button", "button-group", "checkbox", "checkboxes", "container", "date",
        "fieldset", "file", "form", "grid", "html", "image", "number", "panel", "radio", "select", "step", "steps",
        "tabs", "text", "textarea");

    static final String KEY = BuilderFixtures.KEY;
    static final long CAP = 1024 * 1024;

    final ErrorMapper mapper = new ErrorMapper(false, List.of());
    KernelStub kernel;
    MemoryRepository repository;
    InMemoryTranslationCatalogStore catalogs;
    List<Object> events;
    Supplier<SandboxService> sandbox;
    DefinitionService definitions;
    BuilderApi api;
    String baseHash;

    @BeforeEach
    void setUp() {
        kernel = new KernelStub();
        SandboxService service = kernel.service();
        sandbox = () -> service;
        repository = new MemoryRepository();
        catalogs = new InMemoryTranslationCatalogStore();
        events = Collections.synchronizedList(new ArrayList<>());
        build(CAP);
        repository.seed(BuilderFixtures.base());
        baseHash = repository.hashOf(KEY);
    }

    void build(long cap) {
        definitions = DefinitionService.builder().repository(repository).snapshots(new InMemoryDefinitionSnapshotStore(100))
            .sandbox(() -> sandbox.get()).events(events::add).publicCacheSize(16).build();
        api = new BuilderApi(repository, definitions, catalogs, TYPES, cap, "/ctx/api", Clock.systemUTC());
    }

    static byte[] bytes(JsonNode definition) {
        return DatumJson.mapper().writeValueAsBytes(definition);
    }

    static byte[] bytes(String text) {
        return text.getBytes(StandardCharsets.UTF_8);
    }

    FormsReply put(byte[] body, String ifMatch, String changes) {
        return api.update(api.admitUpdate(KEY), body, ifMatch, changes);
    }

    FormsReply put(JsonNode definition) {
        return put(bytes(definition), null, null);
    }

    /** The refusal a write throws, as the error mapper answers it. */
    ErrorResponse refused(Executable write) {
        DatumException failure = assertThrows(DatumException.class, write);
        return mapper.map(failure);
    }

    static List<?> errors(ErrorResponse response) {
        return (List<?>) response.body().get("errors");
    }

    static List<String> codes(ErrorResponse response) {
        List<String> out = new ArrayList<>();
        for (Object item : (List<?>) response.body().get("errors")) {
            out.add(DatumJson.mapper().valueToTree(item).get("code").asString());
        }
        return out;
    }

    static List<String> kernelCodes(ErrorResponse response) {
        List<String> out = new ArrayList<>();
        for (Object item : (List<?>) response.body().get("kernel")) {
            out.add(String.valueOf(((Map<?, ?>) item).get("code")));
        }
        return out;
    }

    static String firstMessage(ErrorResponse response) {
        return DatumJson.mapper().valueToTree(((List<?>) response.body().get("errors")).get(0)).get("message").asString();
    }

    /** A catalog in the nested locale, kind, owner, tree shape, from JSON text. */
    static ObjectNode cat(String json) {
        return (ObjectNode) DatumJson.mapper().readTree(json);
    }

    static JsonNode json(FormsReply reply) {
        return DatumJson.mapper().readTree(reply.body());
    }

    void assertNothingStored() {
        assertThat(repository.saves()).as("nothing reached the repository").isZero();
        assertThat(repository.hashOf(KEY)).as("the stored definition is the one from before").isEqualTo(baseHash);
        assertThat(events).as("no saved event").isEmpty();
    }

    // ------------------------------------------------------------------ the kernel's verdict (the check op)

    @Nested
    class KernelVerdict {

        /** DEF-12 risky-pattern, with the real kernel's answer: 422, the kernel's code and where, nothing stored. */
        @Test
        void aRiskyFormulaIsRefusedAndNeverStored() {
            ObjectNode risky = BuilderFixtures.riskyPattern();
            kernel.answer(risky, BuilderFixtures.capturedAnswer("riskyPattern"));

            ErrorResponse response = refused(() -> put(risky));

            assertThat(response.status()).isEqualTo(422);
            assertThat(codes(response)).containsExactly("pattern.risky");
            assertThat(kernelCodes(response)).containsExactly("pattern.risky");
            assertThat(((Map<?, ?>) ((List<?>) response.body().get("kernel")).get(0)).get("where")).isEqualTo("rules:fx:visibleWhen");
            // A formula problem is worded "where: message" (a structure problem reads "message (at where)").
            assertThat(firstMessage(response)).startsWith("rules:fx:visibleWhen: The pattern \"(a|a?)+\" repeats a repeat").doesNotContain("(at ");
            assertThat(kernel.checks()).hasSize(1);
            assertThat(kernel.checks().get(0).definition()).isEqualTo(risky);
            assertNothingStored();
        }

        /** Duplicate ids are refused, with DEF-03's real answer. */
        @Test
        void duplicateIdsAreRefusedWithTheKernelsCode() {
            ObjectNode dupes = BuilderFixtures.duplicateIds();
            kernel.answer(dupes, BuilderFixtures.capturedAnswer("duplicateIds"));

            ErrorResponse response = refused(() -> put(dupes));

            assertThat(response.status()).isEqualTo(422);
            assertThat(codes(response).get(0)).isEqualTo("component.id.duplicate");
            assertThat(firstMessage(response)).startsWith("Another component already has this id. (at root > content > dup)");
            assertThat(errors(response)).hasSameSizeAs((List<?>) response.body().get("kernel"));
            assertNothingStored();
        }

        /** An unknown type warns and saves: saved, one warning sentence and the kernel's code. */
        @Test
        void anUnknownTypeWarnsAndSaves() {
            ObjectNode definition = BuilderFixtures.base();
            ObjectNode mystery = BuilderFixtures.content(definition).addObject();
            mystery.put("id", "mystery");
            mystery.put("type", "no-such-type");
            mystery.putObject("configuration");
            // The kernel's warning for a type the host's list lacks (definition-structure.ts: rule W, its message).
            kernel.answer(definition, "{\"ok\":true,\"op\":\"check\",\"policy\":\"fail\",\"verdict\":\"ok\",\"problems\":[],\"warnings\":[],"
                + "\"structure\":[],\"structureWarnings\":[{\"code\":\"component.type.unknown\",\"where\":\"root > content > mystery\","
                + "\"message\":\"This host cannot draw a component of this type.\"}]}");

            FormsReply reply = put(definition);

            assertThat(reply.status()).isEqualTo(200);
            JsonNode body = json(reply);
            // The base fixture's "group" is not in the manifest either, so the one sentence names both types.
            assertThat(body.get("warnings")).hasSize(1);
            assertThat(body.get("warnings").get(0).asString()).contains("no-such-type");
            assertThat(body.get("kernelWarnings").get(0).get("code").asString()).isEqualTo("component.type.unknown");
            assertThat(kernel.checks().get(0).types()).isEqualTo(TYPES);
        }

        /** An unparsable formula follows the policy, its "warn" half: a warn verdict saves. */
        @Test
        void aFormulaProblemUnderWarnIsSaved() {
            ObjectNode definition = BuilderFixtures.unknownBrowserFunction();
            kernel.answer(definition, BuilderFixtures.capturedAnswer("browserFunctionUnderWarn"));
            assertThat(put(definition).status()).isEqualTo(200);
            assertThat(repository.saves()).isEqualTo(1);
        }

        /** A formula problem under the fail policy is worded "where: message" (a structure problem is not). */
        @Test
        void aFormulaFailureIsWordedWithItsWhereFirst() {
            ObjectNode definition = BuilderFixtures.base();
            BuilderFixtures.content(definition).addObject().put("id", "f1").put("type", "text");
            kernel.answer(definition, "{\"ok\":true,\"op\":\"check\",\"policy\":\"fail\",\"verdict\":\"fail\",\"problems\":"
                + "[{\"code\":\"formula.parse\",\"where\":\"rules:f1:visibleWhen\",\"message\":\"Unexpected token.\"}],"
                + "\"warnings\":[],\"structure\":[],\"structureWarnings\":[]}");

            ErrorResponse response = refused(() -> put(definition));

            assertThat(response.status()).isEqualTo(422);
            assertThat(codes(response)).containsExactly("formula.parse");
            assertThat(firstMessage(response)).isEqualTo("rules:f1:visibleWhen: Unexpected token.");
            assertNothingStored();
        }

        /**
         * The hash the lock checked goes to the repository (FormDefinitionRepository#save(definition, expectedSha256)),
         * and a repository that refuses it because another instance won the race is a 409 with nothing stored.
         */
        @Test
        void theRepositoryIsToldTheHashTheSaveBuildsOnAndMayRefuseARace() {
            ObjectNode definition = BuilderFixtures.base();
            BuilderFixtures.content(definition).addObject().put("id", "raced").put("type", "text");
            repository.raceOnNextSave();

            ErrorResponse response = refused(() -> put(definition));

            assertThat(response.status()).isEqualTo(409);
            assertThat(codes(response)).contains("form.outdated");
            assertThat(repository.expectedHashes()).containsExactly(baseHash);
            assertNothingStored();
        }

        /** A sandbox that cannot answer is 503, nothing saved. */
        @Test
        void aSandboxThatCannotAnswerIs503() {
            kernel.mode(KernelStub.Mode.UNAVAILABLE);
            ObjectNode definition = BuilderFixtures.base();
            BuilderFixtures.content(definition).addObject().put("id", "b").put("type", "text");

            ErrorResponse response = refused(() -> put(definition));

            assertThat(response.status()).isEqualTo(503);
            assertThat(response.body().get("code")).isEqualTo("server.unavailable");
            assertThat(firstMessage(response)).startsWith("The form could not be checked because the server runtime is not available");
            assertNothingStored();
        }

        /** No runtime configured at all (no SandboxService bean): the same 503, never a save without a check. */
        @Test
        void noRuntimeAtAllIs503() {
            sandbox = () -> {
                throw new ProgramUnavailableException("The Datum sandbox runtime is not configured.");
            };
            ErrorResponse response = refused(() -> put(BuilderFixtures.duplicateIds()));
            assertThat(response.status()).isEqualTo(503);
            assertThat(response.body().get("code")).isEqualTo("server.unavailable");
            assertNothingStored();
        }

        /**
         * The save's check takes a sandbox slot like any run: with every slot taken it is refused with the busy answer
         * (503 server.busy with Retry-After), nothing runs and nothing is stored; once the slot is free the save goes through.
         */
        @Test
        void aSaveWhileEverySlotIsTakenIsTheBusyAnswer() {
            com.argusvane.datum.sandbox.protocol.RunSlots slots = new com.argusvane.datum.sandbox.protocol.RunSlots(1, java.time.Duration.ZERO, "validation");
            SandboxService bounded = new SandboxService(com.argusvane.datum.sandbox.protocol.ProgramRunner.on(kernel),
                com.argusvane.datum.sandbox.protocol.Program.of(com.argusvane.datum.sandbox.protocol.Program.Kind.SANDBOX,
                    "/* program */".getBytes(StandardCharsets.UTF_8)),
                new com.argusvane.datum.sandbox.protocol.RunScript("/* freeze */"), com.argusvane.datum.sandbox.protocol.ProgramLimits.defaults(),
                com.argusvane.datum.sandbox.protocol.HostOptions.defaults(), slots, new com.argusvane.datum.sandbox.protocol.AbiProbe(),
                com.argusvane.datum.sandbox.protocol.RunLog.slf4j(), null);
            sandbox = () -> bounded;
            ObjectNode definition = BuilderFixtures.base();
            BuilderFixtures.content(definition).addObject().put("id", "b").put("type", "text");

            ErrorResponse response;
            try (com.argusvane.datum.sandbox.protocol.RunSlots.Permit held = slots.acquire()) {
                response = refused(() -> put(definition));
            }
            assertThat(response.status()).isEqualTo(503);
            assertThat(response.body().get("code")).isEqualTo("server.busy");
            assertThat(response.headers()).containsKey("Retry-After");
            assertThat(kernel.checks()).as("nothing ran").isEmpty();
            assertNothingStored();

            assertThat(put(definition).status()).isEqualTo(200);
            assertThat(slots.available()).isEqualTo(1);
        }

        /** A check stopped at its own budget after the guest started: 422 tooCostly, and not tried again at once. */
        @Test
        void aTooCostlyDefinitionIs422AndRememberedWithoutARun() {
            kernel.mode(KernelStub.Mode.TOO_COSTLY);
            ObjectNode definition = BuilderFixtures.duplicateIds();

            ErrorResponse first = refused(() -> put(definition));
            ErrorResponse second = refused(() -> put(definition));

            assertThat(first.status()).isEqualTo(422);
            assertThat(first.body().get("code")).isEqualTo("definition.tooCostly");
            assertThat(second.body().get("code")).isEqualTo("definition.tooCostly");
            assertThat(kernel.checks()).as("the second save was refused from memory").hasSize(1);
            assertNothingStored();
        }

        /** An identical resave hits the verdict cache: the same definition is checked once; BLD-07: same hash. */
        @Test
        void anIdenticalResaveIsCheckedOnceAndKeepsItsHash() {
            FormsReply first = put(BuilderFixtures.base());
            FormsReply second = put(BuilderFixtures.base());
            assertThat(kernel.checks()).hasSize(1);
            assertThat(json(first).get("sha256").asString()).isEqualTo(json(second).get("sha256").asString()).isEqualTo(baseHash);
            assertThat(first.headers().get("ETag")).isEqualTo("\"" + baseHash + "\"");
        }
    }

    // ------------------------------------------------------------------ the host's own refusals

    @Nested
    class OwnRefusals {

        /** Shape problems carry codes, named as the kernel names its structure problems. */
        @Test
        void shapeProblemsCarryCodes() {
            ErrorResponse missing = refused(() -> put(bytes("{\"id\":\"" + KEY + "\",\"root\":{\"id\":\"root\",\"type\":\"form\"}}"), null, null));
            assertThat(missing.status()).isEqualTo(422);
            assertThat(kernelCodes(missing)).containsExactly("definition.version.invalid", "definition.schemaVersion.invalid");
            assertThat(codes(missing)).as("one message per code, in the same order").hasSize(2);

            ErrorResponse page = refused(() -> put(bytes("{\"id\":\"" + KEY + "\",\"version\":\"1\",\"schemaVersion\":\"1\",\"root\":{\"id\":\"root\",\"type\":\"page\"}}"), null, null));
            assertThat(kernelCodes(page)).containsExactly("definition.root.type");

            // Another form's id: the builder's own code, answered 422 (the conformance suite's BLD-03).
            ErrorResponse other = refused(() -> put(bytes("{\"id\":\"other\",\"version\":\"1\",\"schemaVersion\":\"1\",\"root\":{\"id\":\"root\",\"type\":\"form\"}}"), null, null));
            assertThat(other.status()).isEqualTo(422);
            assertThat(kernelCodes(other)).containsExactly("definition.id.mismatch");

            ErrorResponse notJson = refused(() -> put(bytes("not json"), null, null));
            assertThat(notJson.status()).isEqualTo(400);
            assertThat(codes(notJson)).containsExactly("bad_document");
            assertThat(kernel.checks()).as("no refusal here reached the kernel").isEmpty();
            assertNothingStored();
        }

        /** The component cap is refused before the sandbox. */
        @Test
        void theComponentCapIsRefusedBeforeTheSandbox() {
            ObjectNode definition = BuilderFixtures.base();
            for (int n = 0; n <= DefinitionShape.MAX_COMPONENTS; n++) {
                BuilderFixtures.content(definition).addObject().put("id", "c" + n).put("type", "text").putObject("configuration");
            }
            ErrorResponse response = refused(() -> put(definition));
            assertThat(response.status()).isEqualTo(422);
            assertThat(firstMessage(response)).contains("more than 10000 components");
            assertThat(kernel.checks()).isEmpty();
            assertNothingStored();
        }

        /** A number JSON cannot write is refused: 1e999 is refused, nothing saved, never a 500. */
        @Test
        void aNumberJsonCannotWriteIsRefused() {
            String text = DatumJson.mapper().writeValueAsString(BuilderFixtures.base())
                .replaceFirst("\"configuration\":\\{\\}", "\"configuration\":{\"max\":1e999}");
            assertThat(text).contains("1e999");
            ErrorResponse response = refused(() -> put(bytes(text), null, null));
            assertThat(response.status()).isEqualTo(422);
            assertThat(kernelCodes(response)).containsExactly("definition.number.nonFinite");
            assertThat(kernel.checks()).isEmpty();
            assertNothingStored();
        }

        /** A declared length past the cap is 413, at the facade: a body past the cap is 413. */
        @Test
        void aBodyPastTheCapIs413ForBothWrites() {
            build(64);
            byte[] big = bytes(BuilderFixtures.base());
            assertThat(refused(() -> put(big, null, null)).status()).isEqualTo(413);
            assertThat(refused(() -> api.translations(api.admitTranslations(KEY), big, null)).status()).isEqualTo(413);
            assertNothingStored();
        }

        /**
         * What is not strict JSON is 400 bad_document for every write; a lone surrogate never reaches
         * the sandbox request (a 503).
         */
        @Test
        void whatIsNotStrictJsonIs400ForEveryWrite() {
            ObjectNode probe = BuilderFixtures.base();
            probe.putObject("probe").put("NULKEY", "LONE");
            String text = DatumJson.mapper().writeValueAsString(probe);
            for (String body : List.of(text.replace("LONE", "x\\ud800y"), text.replace("LONE", "\\udc00"),
                text.replace("\"NULKEY\"", "\"k\\ud800\""))) {
                ErrorResponse update = refused(() -> put(bytes(body), null, null));
                assertThat(update.status()).as(body).isEqualTo(400);
                assertThat(codes(update)).containsExactly("bad_document");
                ErrorResponse create = refused(() -> api.create(api.admitCreate(), bytes(body.replace(KEY, "fresh")), null));
                assertThat(create.status()).as(body).isEqualTo(400);
            }
            ErrorResponse catalog = refused(() -> api.translations(api.admitTranslations(KEY),
                bytes("{\"catalog\":{\"fr\":{\"form\":{\"title\":\"x\\ud800\"}}}}"), null));
            assertThat(catalog.status()).isEqualTo(400);
            assertThat(kernel.checks()).isEmpty();
            assertNothingStored();
            assertThat(catalogs.read(KEY).catalog()).isEmpty();
            assertThat(put(bytes(text.replace("LONE", "\\ud83d\\ude00")), null, null).status())
                .as("a paired surrogate escape is a character, not a refusal").isEqualTo(200);
        }

        /**
         * One long id over many id-less siblings (980 KB, under the default 1 MB cap) must not exhaust an
         * 8 GiB heap in the shape walk before the kernel: it is a quick 422 with a bounded list.
         */
        @Test
        void aHostileShapeIsRefusedQuicklyWithABoundedList() {
            byte[] body = DefinitionShapeTest.hostileBody(500_000, 160_000);
            assertThat(body.length).isLessThan((int) CAP);
            long started = System.nanoTime();
            ErrorResponse response = refused(() -> put(body, null, null));
            assertThat(System.nanoTime() - started).as("linear, not quadratic").isLessThan(10_000_000_000L);
            assertThat(response.status()).isEqualTo(422);
            assertThat(kernelCodes(response)).hasSizeLessThanOrEqualTo(DefinitionShape.MAX_PROBLEMS + 3)
                .contains("definition.problemsTruncated", "definition.tooManyComponents");
            assertThat(kernel.checks()).isEmpty();
            assertNothingStored();
        }

        @Test
        void aLocaleChangesHeaderThatIsNotValidIs400() {
            for (String header : List.of("{", "[1,2", "\"fr\"", "{\"removed\":[\"" + "a".repeat(64 * 1024) + "\"]}", "{\"removed\":[1]}",
                "{\"renamed\":[{\"from\":\"fr\"}]}", "{\"renamed\":[\"fr\"]}", "{\"removed\":[\"fr\"]} trailing")) {
                ErrorResponse response = refused(() -> put(bytes(BuilderFixtures.base()), null, header));
                assertThat(response.status()).as(header).isEqualTo(400);
                assertThat(codes(response)).containsExactly("bad_document");
            }
            assertThat(kernel.checks()).isEmpty();
            assertNothingStored();
        }
    }

    // ------------------------------------------------------------------ the order of refusals

    @Nested
    class Order {

        static final String STALE = "\"" + "0".repeat(64) + "\"";

        @Test
        void tooLargeComesBeforeStale() {
            build(16);
            assertThat(refused(() -> put(bytes("not json at all, and long"), STALE, null)).status()).isEqualTo(413);
        }

        @Test
        void staleComesBeforeNotJson() {
            ErrorResponse response = refused(() -> put(bytes("not json"), STALE, null));
            assertThat(response.status()).isEqualTo(409);
            assertThat(codes(response)).containsExactly("form.outdated");
            assertThat(response.body().get("currentSha256")).isEqualTo(baseHash);
            assertThat(response.body()).as("the hash is named once, as currentSha256").doesNotContainKey("hash");
            assertThat(response.headers().get("ETag")).isEqualTo("\"" + baseHash + "\"");
            assertThat(response.body().get("version")).isEqualTo("1");
        }

        @Test
        void notJsonComesBeforeTheShapeAndTheShapeBeforeTheLocaleHeader() {
            assertThat(refused(() -> put(bytes("{"), null, "{")).status()).isEqualTo(400);
            ErrorResponse shape = refused(() -> put(bytes("{\"id\":\"other\"}"), null, "{"));
            assertThat(shape.status()).isEqualTo(422);
        }

        @Test
        void theLocaleHeaderComesBeforeTheNumberCheckAndTheKernel() {
            String text = DatumJson.mapper().writeValueAsString(BuilderFixtures.base())
                .replaceFirst("\"configuration\":\\{\\}", "\"configuration\":{\"max\":1e999}");
            assertThat(refused(() -> put(bytes(text), null, "{")).status()).isEqualTo(400);
            assertThat(refused(() -> put(bytes(text), null, null)).status()).isEqualTo(422);
            assertThat(kernel.checks()).isEmpty();
        }

        /** Who may write is the application's security in front of the route; existence still comes before the body. */
        @Test
        void existenceComesBeforeTheBody() {
            assertThatThrownBy(() -> api.admitUpdate("no-such-form")).isInstanceOf(FormNotFoundException.class);
            assertThatThrownBy(() -> api.admitUpdate("bad/key")).isInstanceOf(FormNotFoundException.class);
            assertThatThrownBy(() -> api.admitTranslations("no-such-form")).isInstanceOf(FormNotFoundException.class);
            assertThat(api.admitCreate().operation()).isEqualTo(Admission.Operation.CREATE);
        }

        @Test
        void anAdmissionIsForOneWrite() {
            Admission translations = api.admitTranslations(KEY);
            assertThatThrownBy(() -> api.update(translations, bytes(BuilderFixtures.base()), null, null))
                .isInstanceOf(IllegalArgumentException.class);
        }
    }

    // ------------------------------------------------------------------ If-Match (security suite BLD-02)

    @Nested
    class IfMatch {

        @Test
        void theCurrentHashSavesStrongWeakOrBare() {
            for (String tag : List.of("\"" + baseHash + "\"", "W/\"" + baseHash + "\"", baseHash, "  \"" + baseHash + "\"  ")) {
                assertThat(put(bytes(BuilderFixtures.base()), tag, null).status()).as(tag).isEqualTo(200);
            }
        }

        @Test
        void aStarAnEmptyValueOrNoHeaderSavesAsSent() {
            for (String tag : new String[] {"*", "", null}) {
                assertThat(put(bytes(BuilderFixtures.base()), tag, null).status()).isEqualTo(200);
            }
        }

        @Test
        void aStaleWeakTagIsRefused() {
            assertThat(refused(() -> put(bytes(BuilderFixtures.base()), "W/\"weak-stale\"", null)).status()).isEqualTo(409);
            assertNothingStored();
        }

        /** A save landing while the kernel checks this one: the hash is checked again under the lock, so nothing is overwritten. */
        @Test
        void aSaveThatLandsDuringTheCheckWins() {
            ObjectNode theirs = BuilderFixtures.base();
            theirs.put("version", "2");
            kernel.during(request -> repository.seed(theirs));
            ObjectNode mine = BuilderFixtures.base();
            mine.put("version", "3");

            ErrorResponse response = refused(() -> put(bytes(mine), "\"" + baseHash + "\"", null));

            assertThat(response.status()).isEqualTo(409);
            assertThat(response.body().get("version")).isEqualTo("2");
            assertThat(repository.find(KEY).orElseThrow().get("version").asString()).isEqualTo("2");
            assertThat(repository.saves()).isZero();
        }
    }

    // ------------------------------------------------------------------ the save

    @Nested
    class Save {

        @Test
        void aSaveRecordsTheSnapshotAndPublishesTheEventOnce() {
            ObjectNode next = BuilderFixtures.base();
            next.put("version", "2");
            FormsReply reply = put(next);

            String sha = DefinitionService.hash(next);
            assertThat(reply.status()).isEqualTo(200);
            assertThat(reply.headers().get("ETag")).isEqualTo("\"" + sha + "\"");
            assertThat(reply.headers().get("Cache-Control")).isEqualTo("no-store");
            JsonNode body = json(reply);
            assertThat(body.get("version").asString()).isEqualTo("2");
            assertThat(body.get("sha256").asString()).isEqualTo(sha);
            assertThat(body.get("key").asString()).isEqualTo(KEY);
            assertThat(body.has("savedAt")).isTrue();
            assertThat(events).containsExactly(new FormDefinitionSavedEvent(KEY, sha, baseHash));
            assertThat(definitions.snapshot(KEY, sha)).isEqualTo(next);
            assertThat(repository.find(KEY).orElseThrow()).isEqualTo(next);
        }

        /**
         * Through the host's default (guarded) publisher a listener's failure is logged and is not the save
         * warning "could not record this version", which named the wrong cause (the version is recorded).
         */
        @Test
        void aListenerThatThrowsDoesNotTurnASavedFormIntoAFailure() {
            definitions = DefinitionService.builder().repository(repository).snapshots(new InMemoryDefinitionSnapshotStore(100)).sandbox(() -> sandbox.get())
                .events(com.argusvane.datum.core.DatumEventPublisher.guarded(event -> {
                    throw new IllegalStateException("listener failed");
                })).publicCacheSize(16).build();
            api = new BuilderApi(repository, definitions, catalogs, TYPES, CAP, "/ctx/api", Clock.systemUTC());
            ObjectNode next = BuilderFixtures.base();
            next.put("version", "2");
            FormsReply reply = put(next);
            assertThat(reply.status()).isEqualTo(200);
            assertThat(json(reply).path("warnings").toString()).doesNotContain("could not record this version");
            assertThat(definitions.snapshot(KEY, json(reply).get("sha256").asString())).isEqualTo(next);
            assertThat(repository.saves()).isEqualTo(1);
        }

        /**
         * An application's own publisher is used as given, so one that throws once the
         * version is recorded (an outbox write that failed) reaches the caller of the save as thrown; it is never the snapshot
         * warning, whose words would name the wrong cause. The form is stored and its version recorded.
         */
        @Test
        void anApplicationsOwnPublisherThatThrowsReachesTheCallerOfTheSave() {
            InMemoryDefinitionSnapshotStore snapshots = new InMemoryDefinitionSnapshotStore(100);
            definitions = DefinitionService.builder().repository(repository).snapshots(snapshots).sandbox(() -> sandbox.get()).events(event -> {
                throw new IllegalStateException("outbox down");
            }).publicCacheSize(16).build();
            api = new BuilderApi(repository, definitions, catalogs, TYPES, CAP, "/ctx/api", Clock.systemUTC());
            ObjectNode next = BuilderFixtures.base();
            next.put("version", "2");
            org.assertj.core.api.Assertions.assertThatThrownBy(() -> put(next)).isInstanceOf(IllegalStateException.class)
                .hasMessage("outbox down");
            assertThat(repository.saves()).isEqualTo(1);
            assertThat(snapshots.find(KEY, DefinitionService.hash(next))).hasValue(next);
        }

        /**
         * A snapshot store that fails is the warning even for a hash the service recorded before (an author
         * reverting to an earlier version while the snapshot table is read-only). The failure is the store's, not a
         * publisher's, so the answer is the warning and not an error for a form that was stored.
         */
        @Test
        void aSnapshotStoreThatFailsForAVersionRecordedBeforeIsStillTheWarning() {
            java.util.concurrent.atomic.AtomicBoolean readOnly = new java.util.concurrent.atomic.AtomicBoolean();
            InMemoryDefinitionSnapshotStore memory = new InMemoryDefinitionSnapshotStore(100);
            DefinitionSnapshotStore flaky = new DefinitionSnapshotStore() {
                @Override
                public void record(String key, String sha256, ObjectNode definition) {
                    if (readOnly.get()) {
                        throw new IllegalStateException("snapshot table read-only");
                    }
                    memory.record(key, sha256, definition);
                }

                @Override
                public Optional<ObjectNode> find(String key, String sha256) {
                    return memory.find(key, sha256);
                }
            };
            definitions = DefinitionService.builder().repository(repository).snapshots(flaky).sandbox(() -> sandbox.get()).events(events::add).publicCacheSize(16).build();
            api = new BuilderApi(repository, definitions, catalogs, TYPES, CAP, "/ctx/api", Clock.systemUTC());
            ObjectNode two = BuilderFixtures.base();
            two.put("version", "2");
            ObjectNode three = BuilderFixtures.base();
            three.put("version", "3");
            assertThat(put(two).status()).isEqualTo(200);
            assertThat(put(three).status()).isEqualTo(200);

            readOnly.set(true);
            FormsReply reverted = put(two);

            assertThat(reverted.status()).isEqualTo(200);
            assertThat(json(reverted).get("warnings").toString()).contains("could not record this version");
            assertThat(json(reverted).get("sha256").asString()).isEqualTo(DefinitionService.hash(two));
            assertThat(repository.saves()).isEqualTo(3);
        }

        /** A snapshot store that cannot write is still a stored form with a warning (the version is recorded on the next read). */
        @Test
        void aSnapshotStoreThatFailsTurnsTheSaveIntoAWarningNotAFailure() {
            DefinitionSnapshotStore failing = new DefinitionSnapshotStore() {
                @Override
                public void record(String key, String sha256, ObjectNode definition) {
                    throw new IllegalStateException("snapshot table down");
                }

                @Override
                public Optional<ObjectNode> find(String key, String sha256) {
                    return Optional.empty();
                }
            };
            definitions = DefinitionService.builder().repository(repository).snapshots(failing).sandbox(() -> sandbox.get()).events(event -> { }).publicCacheSize(16).build();
            api = new BuilderApi(repository, definitions, catalogs, TYPES, CAP, "/ctx/api", Clock.systemUTC());
            ObjectNode next = BuilderFixtures.base();
            next.put("version", "2");
            FormsReply reply = put(next);
            assertThat(reply.status()).isEqualTo(200);
            assertThat(json(reply).get("warnings").toString()).contains("could not record this version");
            assertThat(repository.saves()).isEqualTo(1);
        }

        /**
         * A repository that changes what it stores. The ETag, the body's hash, the snapshot and the
         * event name what is stored, so the next If-Match (read from GET) matches.
         */
        @Test
        void aRepositoryThatChangesWhatItStoresIsAnsweredWithWhatItStored() {
            FormDefinitionRepository dropsVendorKeys = new FormDefinitionRepository() {
                public Optional<ObjectNode> find(String key) {
                    return repository.find(key);
                }

                public SavedForm save(ObjectNode definition) {
                    ObjectNode copy = definition.deepCopy();
                    copy.remove("x-vendor");
                    return repository.save(copy);
                }

                public SavedForm save(ObjectNode definition, String expectedSha256) {
                    ObjectNode copy = definition.deepCopy();
                    copy.remove("x-vendor");
                    return repository.save(copy, expectedSha256);
                }
            };
            definitions = DefinitionService.builder().repository(dropsVendorKeys).snapshots(new InMemoryDefinitionSnapshotStore(100))
                .sandbox(() -> sandbox.get()).events(events::add).publicCacheSize(16).build();
            api = new BuilderApi(dropsVendorKeys, definitions, catalogs, TYPES, CAP, "", Clock.systemUTC());
            ObjectNode next = BuilderFixtures.base();
            next.put("version", "2");
            next.put("x-vendor", "dropped by the store");
            ObjectNode stored = next.deepCopy();
            stored.remove("x-vendor");
            String sha = DefinitionService.hash(stored);

            FormsReply reply = put(next);

            assertThat(reply.status()).isEqualTo(200);
            assertThat(reply.headers().get("ETag")).isEqualTo("\"" + sha + "\"").isEqualTo("\"" + dropsVendorKeys.current(KEY).sha256() + "\"");
            assertThat(json(reply).get("sha256").asString()).isEqualTo(sha);
            assertThat(events).containsExactly(new FormDefinitionSavedEvent(KEY, sha, baseHash));
            assertThat(definitions.snapshot(KEY, sha)).isEqualTo(stored);
            // The page builds on what GET answers; that save goes through.
            assertThat(put(bytes(stored), "\"" + sha + "\"", null).status()).isEqualTo(200);
        }

        @Test
        void aReadOnlyRepositoryIs501AndTheKernelRanFirst() {
            api = new BuilderApi(new com.argusvane.datum.forms.FormDefinitionRepository() {
                public java.util.Optional<ObjectNode> find(String key) {
                    return repository.find(key);
                }

                public com.argusvane.datum.forms.SavedForm save(ObjectNode definition) {
                    throw new FormStoreReadOnlyException();
                }

                public com.argusvane.datum.forms.SavedForm save(ObjectNode definition, String expectedSha256) {
                    throw new FormStoreReadOnlyException();
                }
            }, definitions, catalogs, TYPES, CAP, "", Clock.systemUTC());
            assertThat(refused(() -> put(BuilderFixtures.base())).status()).isEqualTo(501);
            assertNothingStored();
        }
    }

    // ------------------------------------------------------------------ locales and the catalog

    @Nested
    class Locales {

        ObjectNode withLocales(String... codes) {
            ObjectNode definition = BuilderFixtures.base();
            var list = definition.putObject("localization").putArray("supportedLocales");
            for (String code : codes) {
                list.addObject().put("code", code).put("label", code);
            }
            return definition;
        }

        /** The title in three languages, and a component label only German has. */
        ObjectNode catalog() {
            return cat("""
                {"de": {"components": {"other": {"label": "Nur deutsch"}}, "form": {"title": "Hallo"}},
                 "en": {"form": {"title": "Hello"}},
                 "fr": {"form": {"title": "Bonjour"}}}
                """);
        }

        @Test
        void aSaveThatRemovesLocalesDropsTheirEntriesAndSaysWhich() {
            repository.seed(withLocales("en", "fr", "de"));
            catalogs.write(KEY, catalog(), null);

            FormsReply reply = put(withLocales("en", "fr"));

            assertThat(reply.headers().get(BuilderApi.REMOVED_LOCALES_HEADER)).isEqualTo("de");
            assertThat(catalogs.read(KEY).catalog()).isEqualTo(cat("{\"en\":{\"form\":{\"title\":\"Hello\"}},\"fr\":{\"form\":{\"title\":\"Bonjour\"}}}"));
            assertThat(json(reply).get("catalog").toString()).isEqualTo("{\"en\":{\"form\":{\"title\":\"Hello\"}},\"fr\":{\"form\":{\"title\":\"Bonjour\"}}}");
        }

        @Test
        void aRenameMovesTheLocaleAndIsNotListedAsRemoved() {
            repository.seed(withLocales("en", "fr", "de"));
            catalogs.write(KEY, catalog(), null);

            FormsReply reply = put(bytes(withLocales("en", "fr-CA", "de")), null,
                "{\"removed\":[],\"renamed\":[{\"from\":\"fr\",\"to\":\"fr-CA\"}]}");

            assertThat(reply.headers()).doesNotContainKey(BuilderApi.REMOVED_LOCALES_HEADER);
            assertThat(catalogs.read(KEY).catalog().propertyNames()).containsExactlyInAnyOrder("de", "en", "fr-CA");
            assertThat(catalogs.read(KEY).catalog().path("fr-CA").path("form").path("title").asString()).isEqualTo("Bonjour");
        }

        @Test
        void aRenameOntoALocaleTheCatalogHoldsMergesAndTheMovedTextWins() {
            repository.seed(withLocales("en", "fr", "fr-CA"));
            catalogs.write(KEY, cat("""
                {"fr": {"form": {"title": "Bonjour", "description": "Moved"}},
                 "fr-CA": {"form": {"title": "Allo", "description": "Kept"}, "chrome": {"hello": {"text": "Salut"}}}}
                """), null);

            put(bytes(withLocales("en", "fr-CA")), null, "{\"renamed\":[{\"from\":\"fr\",\"to\":\"fr-CA\"}]}");

            assertThat(catalogs.read(KEY).catalog()).isEqualTo(cat("""
                {"fr-CA": {"chrome": {"hello": {"text": "Salut"}}, "form": {"description": "Moved", "title": "Bonjour"}}}
                """));
        }

        @Test
        void aSaveThatRemovesNoLocaleLeavesTheCatalogAlone() {
            repository.seed(withLocales("en", "fr"));
            String etag = catalogs.write(KEY, catalog(), null);
            FormsReply reply = put(withLocales("en", "fr", "es"));
            assertThat(reply.headers()).doesNotContainKey(BuilderApi.REMOVED_LOCALES_HEADER);
            assertThat(catalogs.read(KEY).etag()).as("the entries of a locale the form never declared stay").isEqualTo(etag);
        }

        @Test
        void theHeadersRemovedLocalesGoToo() {
            repository.seed(withLocales("en", "fr"));
            catalogs.write(KEY, catalog(), null);
            FormsReply reply = put(bytes(withLocales("en", "fr")), null, "{\"removed\":[\"de\"]}");
            assertThat(reply.headers().get(BuilderApi.REMOVED_LOCALES_HEADER)).isEqualTo("de");
            assertThat(catalogs.read(KEY).catalog().has("de")).isFalse();
            assertThat(catalogs.read(KEY).catalog().has("fr")).isTrue();
        }

        /** The header only tells of locales that really went; the save itself stands. */
        @Test
        void aCatalogThatCannotBeMovedIsNotSaidToHaveLostItsLocales() {
            TranslationCatalogStore down = new TranslationCatalogStore() {
                public StoredCatalog read(String formKey) {
                    return catalogs.read(formKey);
                }

                public String write(String formKey, ObjectNode catalog, String ifMatch) {
                    throw new IllegalStateException("the catalog table is down");
                }
            };
            api = new BuilderApi(repository, definitions, down, TYPES, CAP, "", Clock.systemUTC());
            repository.seed(withLocales("en", "fr", "de"));
            catalogs.write(KEY, catalog(), null);

            FormsReply reply = put(withLocales("en", "fr"));

            assertThat(reply.status()).isEqualTo(200);
            assertThat(reply.headers()).doesNotContainKey(BuilderApi.REMOVED_LOCALES_HEADER);
            assertThat(json(reply).get("warnings").toString()).contains("could not be moved");
            assertThat(catalogs.read(KEY).catalog().has("de")).isTrue();
            assertThat(repository.saves()).isEqualTo(1);
        }

        /** Three lost races and then a catalog that cannot be read is still a stored save, never a 500. */
        @Test
        void aCatalogThatKeepsChangingAndThenCannotBeReadIsStillASave() {
            AtomicInteger reads = new AtomicInteger();
            TranslationCatalogStore racing = new TranslationCatalogStore() {
                public StoredCatalog read(String formKey) {
                    if (reads.incrementAndGet() > 3) {
                        throw new IllegalStateException("the catalog table went away");
                    }
                    return catalogs.read(formKey);
                }

                public String write(String formKey, ObjectNode catalog, String ifMatch) {
                    throw new FormOutdatedException("someone-else");
                }
            };
            api = new BuilderApi(repository, definitions, racing, TYPES, CAP, "", Clock.systemUTC());
            repository.seed(withLocales("en", "fr", "de"));
            catalogs.write(KEY, catalog(), null);

            FormsReply reply = put(withLocales("en", "fr"));

            assertThat(reply.status()).isEqualTo(200);
            assertThat(reply.headers()).doesNotContainKey(BuilderApi.REMOVED_LOCALES_HEADER);
            assertThat(json(reply).get("warnings").toString()).contains("changed at the same time");
            assertThat(reads.get()).isEqualTo(4);
        }

        @Test
        void aRefusedSaveMovesNothing() {
            repository.seed(withLocales("en", "fr", "de"));
            String etag = catalogs.write(KEY, catalog(), null);
            baseHash = repository.hashOf(KEY);
            ObjectNode refusedOne = withLocales("en");
            BuilderFixtures.content(refusedOne).addObject().put("id", "x").put("type", "text").putObject("configuration");
            BuilderFixtures.content(refusedOne).addObject().put("id", "x").put("type", "text").putObject("configuration");
            kernel.answer(refusedOne, "{\"ok\":true,\"op\":\"check\",\"policy\":\"fail\",\"verdict\":\"fail\",\"problems\":[],\"warnings\":[],"
                + "\"structure\":[{\"code\":\"component.id.duplicate\",\"where\":\"root > content > x\",\"message\":\"Another component already has this id.\"}],"
                + "\"structureWarnings\":[]}");
            assertThat(refused(() -> put(bytes(refusedOne), null, "{\"removed\":[\"fr\",\"de\"]}")).status()).isEqualTo(422);
            assertThat(catalogs.read(KEY).etag()).isEqualTo(etag);
            assertNothingStored();
        }
    }

    // ------------------------------------------------------------------ translations (If-Match on the catalog)

    @Nested
    class Translations {

        FormsReply save(String body, String ifMatch) {
            return api.translations(api.admitTranslations(KEY), bytes(body), ifMatch);
        }

        @Test
        void theCatalogsEtagGuardsTheWrite() {
            String etag = catalogs.read(KEY).etag();
            FormsReply first = save("{\"catalog\":{\"fr\":{\"form\":{\"title\":\"Bonjour\"}}}}", "\"" + etag + "\"");
            assertThat(first.status()).isEqualTo(200);
            String next = InMemoryTranslationCatalogStore.etag(cat("{\"fr\":{\"form\":{\"title\":\"Bonjour\"}}}"));
            assertThat(first.headers().get("ETag")).isEqualTo("\"" + next + "\"");
            assertThat(json(first).get("entries").asInt()).isEqualTo(1);

            // The page that read the first etag is now behind.
            ErrorResponse stale = refused(() -> save("{\"catalog\":{\"fr\":{\"form\":{\"title\":\"Salut\"}}}}", "\"" + etag + "\""));
            assertThat(stale.status()).isEqualTo(409);
            assertThat(codes(stale)).containsExactly("form.outdated");
            assertThat(stale.headers().get("ETag")).isEqualTo("\"" + next + "\"");
            assertThat(catalogs.read(KEY).catalog()).isEqualTo(cat("{\"fr\":{\"form\":{\"title\":\"Bonjour\"}}}"));

            assertThat(save("{\"fr\":{\"form\":{\"title\":\"Salut\"}}}", null).status()).as("the bare catalog, no precondition").isEqualTo(200);
            assertThat(catalogs.read(KEY).catalog()).isEqualTo(cat("{\"fr\":{\"form\":{\"title\":\"Salut\"}}}"));
        }

        @Test
        void entriesCountsTheTextsOfEveryLocale() {
            FormsReply reply = save("{\"catalog\":{\"fr\":{\"form\":{\"title\":\"T\",\"messages\":{\"required\":\"R\"}},\"components\":{\"a\":{\"label\":\"L\"}}},\"de\":{\"form\":{\"title\":\"T\"}}}}", null);
            assertThat(json(reply).get("entries").asInt()).isEqualTo(4);
        }

        @Test
        void aStaleTagComesBeforeABodyThatIsNotJson() {
            assertThat(refused(() -> save("not json", "\"stale\"")).status()).isEqualTo(409);
            assertThat(refused(() -> save("not json", null)).status()).isEqualTo(400);
        }

        @Test
        void whatIsNotACatalogIs422WithTheJsonPathOfEachOffence() {
            ErrorResponse response = refused(() -> save("{\"catalog\":{\"fr-CA\":{\"components\":{\"fullName\":{\"label\":4}},\"fields\":{}},\"not a locale\":{}}}", null));
            assertThat(response.status()).isEqualTo(422);
            assertThat(response.body().get("code")).isEqualTo("catalog.invalid");
            assertThat(codes(response)).containsOnly("catalog.invalid").hasSize(3);
            assertThat(firstMessage(response)).isEqualTo("$['fr-CA'].components.fullName.label must be text or an object.");
            assertThat(catalogs.read(KEY).catalog()).isEmpty();
        }

        @Test
        void aKeyThatIsNotSafeOrAKindThatDoesNotExistIsRefusedNamingItsPath() {
            ErrorResponse proto = refused(() -> save("{\"catalog\":{\"fr\":{\"components\":{\"__proto__\":{\"label\":\"x\"}}}}}", null));
            assertThat(proto.status()).isEqualTo(422);
            assertThat(firstMessage(proto)).contains("$.fr.components.__proto__");
            ErrorResponse kind = refused(() -> save("{\"catalog\":{\"fr\":{\"keys\":{}}}}", null));
            assertThat(firstMessage(kind)).contains("not a kind");
            assertThat(catalogs.read(KEY).catalog()).isEmpty();
        }

        @Test
        void aCatalogDeeperThanTheCatalogDepthIsNotJson() {
            String deep = "{\"catalog\":" + "[".repeat(40) + "]".repeat(40) + "}";
            assertThat(refused(() -> save(deep, null)).status()).isEqualTo(400);
        }

        @Test
        void blankTextsAndEmptyBranchesAreDroppedWhenTheCatalogIsNormalized() {
            FormsReply reply = save("{\"catalog\":{\"fr\":{\"form\":{\"title\":\"Bonjour\",\"description\":\"  \"},\"chrome\":{\"empty\":{\"text\":\" \"}}},\"de\":{}}}", null);
            assertThat(json(reply).get("catalog").toString()).isEqualTo("{\"fr\":{\"form\":{\"title\":\"Bonjour\"}}}");
            assertThat(TranslationCatalog.toJson(catalogs.read(KEY).catalog()).toString()).isEqualTo("{\"fr\":{\"form\":{\"title\":\"Bonjour\"}}}");
        }
    }

    // ------------------------------------------------------------------ create

    @Nested
    class Create {

        FormsReply create(JsonNode definition) {
            return api.create(api.admitCreate(), bytes(definition), null);
        }

        ObjectNode named(String id) {
            ObjectNode definition = BuilderFixtures.base();
            definition.put("id", id);
            return definition;
        }

        @Test
        void aNewIdIsCreatedWith201AndItsAddress() {
            FormsReply reply = create(named("intake"));
            assertThat(reply.status()).isEqualTo(201);
            assertThat(reply.headers().get("Location")).isEqualTo("/ctx/api/forms/intake/definition?public=false");
            assertThat(repository.find("intake")).isPresent();
            assertThat(events).containsExactly(new FormDefinitionSavedEvent("intake", DefinitionService.hash(named("intake")), null));
        }

        @Test
        void anIdInUseIs409() {
            ErrorResponse response = refused(() -> create(named(KEY)));
            assertThat(response.status()).isEqualTo(409);
            assertThat(response.body().get("code")).isEqualTo("form.exists");
            assertNothingStored();
        }

        @Test
        void anIdThatCannotBeAnAddressIs422() {
            ErrorResponse response = refused(() -> create(named("no/slash")));
            assertThat(response.status()).isEqualTo(422);
            assertThat(kernelCodes(response)).containsExactly("definition.id.invalid");
            assertThat(repository.find("no/slash")).isEmpty();
        }

        @Test
        void aCreateIsCheckedByTheKernelToo() {
            ObjectNode risky = BuilderFixtures.riskyPattern();
            risky.put("id", "risky-new");
            JsonNode original = BuilderFixtures.riskyPattern();
            // The captured answer is for the suite's id; the stub keys on the exact definition, so register it for this one.
            kernel.answer(risky, BuilderFixtures.capturedAnswer("riskyPattern"));
            assertThat(original).isNotEqualTo(risky);
            assertThat(refused(() -> create(risky)).status()).isEqualTo(422);
            assertThat(repository.find("risky-new")).isEmpty();
        }
    }
}
