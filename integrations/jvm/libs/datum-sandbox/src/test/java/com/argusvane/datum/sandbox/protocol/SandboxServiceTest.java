package com.argusvane.datum.sandbox.protocol;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.core.DefinitionTooDeepException;
import com.argusvane.datum.core.ProgramUnavailableException;
import com.argusvane.datum.sandbox.protocol.SandboxException.Reason;
import com.argusvane.datum.sandbox.wasi.Budget;
import com.argusvane.datum.sandbox.wasi.RunOutput;
import com.argusvane.datum.sandbox.wasi.Termination;
import com.argusvane.datum.sandbox.wasi.OutputCapExceededException;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Function;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

/** The service over a runtime that plays the guest: the order of the checks, the gate, the outcome. */
class SandboxServiceTest {

    private static final Program PROGRAM = Program.of(Program.Kind.SANDBOX, "/* program */".getBytes(StandardCharsets.UTF_8));
    private static final RunScript SCRIPTS = new RunScript("/* freeze */");
    private static final HostOptions HOST = new HostOptions("warn", "allow", "UTC",
        Clock.fixed(Instant.parse("2026-10-15T12:00:00Z"), ZoneOffset.UTC));

    private final List<String[]> logged = new ArrayList<>();

    private SandboxService service(FakeRuntime runtime) {
        return service(runtime, new RunSlots(2, Duration.ZERO, "validation"));
    }

    private SandboxService service(FakeRuntime runtime, RunSlots slots) {
        return new SandboxService(runtime, PROGRAM, SCRIPTS, ProgramLimits.defaults(), HOST, slots, new AbiProbe(),
            (form, level, message, data) -> logged.add(new String[] {form, level, message, data == null ? null : data.toString()}), null);
    }

    private static ObjectNode json(String text) {
        try {
            return (ObjectNode) StrictJson.decode(text);
        } catch (StrictJson.NotJsonException e) {
            throw new AssertionError(e);
        }
    }

    private static ObjectNode context() {
        return json("{\"formId\":\"f\",\"form\":{\"id\":\"root\",\"type\":\"form\",\"configuration\":{},\"children\":{\"content\":["
            + "{\"id\":\"name\",\"type\":\"text\",\"configuration\":{\"required\":true}}]}},\"values\":{},\"locale\":\"en\","
            + "\"formulaErrors\":\"fail\",\"today\":\"1999-01-01\"}");
    }

    private static SandboxException failure(Runnable run) {
        try {
            run.run();
        } catch (SandboxException e) {
            return e;
        }
        throw new AssertionError("No SandboxException.");
    }

    @Test
    void aValidationRunsAfterTheGateWithAFreshNonceAndTheHostsKeys() {
        FakeRuntime runtime = FakeRuntime.answering("{\"errors\":[{\"code\":\"required\",\"componentId\":\"name\"}]}");
        SandboxService service = service(runtime);
        ObjectNode context = context();
        SandboxResult result = service.validate(context, List.of(new RuleModule("acme", "1.0.0", "({ validators: [] })")), true);
        assertThat(result.outcome().get("errors").get(0).get("code").stringValue()).isEqualTo("required");
        assertThat(result.elapsedMs()).isGreaterThanOrEqualTo(0);

        // The probe ran first, once, with the host's floor, registering nothing.
        assertThat(runtime.calls).hasSize(2);
        FakeRuntime.Call probe = runtime.calls.get(0);
        assertThat(FakeRuntime.isProbe(probe)).isTrue();
        assertThat(probe.input().get("abi").stringValue()).isEqualTo("1.0.0");
        assertThat(probe.input().get("op").stringValue()).isEqualTo("inspect");
        assertThat(probe.script()).doesNotContain("register(evaluate(");

        FakeRuntime.Call run = runtime.calls.get(1);
        assertThat(run.program()).isEqualTo(PROGRAM);
        assertThat(run.argv()).containsExactly("qjs", "--std", "-I", "/app/datum-sandbox-program.js", "/app/run.js");
        assertThat(run.script()).isEqualTo(SCRIPTS.sandbox(List.of(new RuleModule("acme", "1.0.0", "({ validators: [] })")), RunScript.Entry.RUN));
        assertThat(run.nonce()).isNotNull().isNotEqualTo(probe.nonce());
        assertThat(run.budget()).isEqualTo(ProgramLimits.defaults().validationBudget());
        // The host decides today, formulaErrors and riskyPatterns; the caller's node is not changed.
        assertThat(run.input().get("today").stringValue()).isEqualTo("2026-10-15");
        assertThat(run.input().get("formulaErrors").stringValue()).isEqualTo("warn");
        assertThat(run.input().get("riskyPatterns").stringValue()).isEqualTo("allow");
        assertThat(context.get("today").stringValue()).isEqualTo("1999-01-01");

        // The proof is kept per program: the next run does not ask again.
        service.validate(context(), List.of(), true);
        assertThat(runtime.probes()).isEqualTo(1);
        assertThat(runtime.work()).hasSize(2);
        assertThat(runtime.work().get(0).nonce()).isNotEqualTo(runtime.work().get(1).nonce());
    }

    @Test
    void aProgramThatDoesNotAnswerForTheFloorJudgesNothing() {
        FakeRuntime runtime = new FakeRuntime(call -> call.framed(
            "{\"ok\":false,\"error\":{\"code\":\"abi_mismatch\",\"message\":\"This program answers sandbox ABI 0.3.0\"}}"));
        SandboxService service = service(runtime);
        assertThatThrownBy(() -> service.validate(context(), List.of(), true))
            .isInstanceOfSatisfying(ProgramUnavailableException.class, e -> {
                assertThat(e.getMessage()).contains("1.0.0").contains("(abi_mismatch)");
                assertThat(e.httpStatus()).isEqualTo(503);
            });
        assertThat(runtime.calls).hasSize(1);
        assertThat(runtime.work()).isEmpty();
        // Not remembered: the next run asks again.
        assertThatThrownBy(() -> service.validate(context(), List.of(), true)).isInstanceOf(ProgramUnavailableException.class);
        assertThat(runtime.calls).hasSize(2);
        // Not JSON, or no ok: unknown.
        FakeRuntime garbage = new FakeRuntime(call -> call.framed("not json"));
        assertThatThrownBy(() -> service(garbage).validate(context(), List.of(), true))
            .isInstanceOf(ProgramUnavailableException.class).hasMessageContaining("(unknown)");
    }

    @Test
    void theOutcomeMustBeAnObjectWithAnErrorsList() {
        for (String bad : new String[] {"{}", "[]", "{\"errors\":{}}", "1", "null", "{\"errors\":null}"}) {
            SandboxException e = failure(() -> service(FakeRuntime.answering(bad)).validate(context(), List.of(), true));
            assertThat(e.reason()).as(bad).isEqualTo(Reason.NO_OUTCOME);
            assertThat(e.code()).isEqualTo("wasm.execution_error");
        }
        for (String bad : new String[] {"nope", "{\"errors\":[]} trailing", "", "{\"errors\":[\"\\ud800\"]}"}) {
            SandboxException e = failure(() -> service(FakeRuntime.answering(bad)).validate(context(), List.of(), true));
            assertThat(e.reason()).as(bad).isIn(Reason.NOT_JSON, Reason.NO_OUTCOME);
        }
        assertThat(failure(() -> service(FakeRuntime.answering("nope")).validate(context(), List.of(), true)).reason()).isEqualTo(Reason.NOT_JSON);
        // A repeated key is not JSON the host reads: the host and another reader of the same answer could keep different values.
        assertThat(failure(() -> service(FakeRuntime.answering("{\"errors\":[],\"errors\":[{\"path\":\"a\"}]}")).validate(context(), List.of(), true))
            .reason()).isEqualTo(Reason.NOT_JSON);
    }

    /** Past 8 MiB of UTF-16 code units, nothing of the outcome is read. */
    @Test
    void anOutcomePast8MiBIsRefused() {
        String head = "{\"errors\":[],\"pad\":\"";
        String tail = "\"}";
        int fill = SandboxService.MAX_OUTCOME_LENGTH - head.length() - tail.length();
        String atCap = head + "x".repeat(fill) + tail;
        assertThat(atCap).hasSize(SandboxService.MAX_OUTCOME_LENGTH);
        assertThat(service(FakeRuntime.answering(atCap)).validate(context(), List.of(), true).outcome().get("pad").stringValue()).hasSize(fill);

        String over = head + "x".repeat(fill + 1) + tail;
        SandboxException e = failure(() -> service(FakeRuntime.answering(over)).validate(context(), List.of(), true));
        assertThat(e.reason()).isEqualTo(Reason.OUTCOME_TOO_LARGE);
        assertThat(e.code()).isEqualTo("outcome_too_large");
        assertThat(e.httpStatus()).isEqualTo(503);
        assertThat(e.getMessage()).startsWith("outcome.tooLarge");
        assertThat(VerdictMapper.statusOf(e.code())).as("the TypeScript table agrees: a failed run is a 503").isEqualTo(503);

        // Characters, not bytes: 5 Mi two-byte characters (10 MiB of UTF-8) are under the cap.
        String wide = head + "\u00e9".repeat(5 * 1024 * 1024) + tail;
        assertThat(service(FakeRuntime.answering(wide)).validate(context(), List.of(), true).outcome().has("pad")).isTrue();
        // Even a malformed outcome past the cap is refused for its size: nothing of it is parsed.
        assertThat(failure(() -> service(FakeRuntime.answering("x".repeat(SandboxService.MAX_OUTCOME_LENGTH + 1))).validate(context(), List.of(), true)).reason())
            .isEqualTo(Reason.OUTCOME_TOO_LARGE);
        // Bytes that are not UTF-8 are not JSON, past the cap as under it (as when the whole text was decoded).
        byte[] broken = ("{\"errors\":[],\"pad\":\"" + "x".repeat(SandboxService.MAX_OUTCOME_LENGTH) + "\"}").getBytes(StandardCharsets.UTF_8);
        broken[20] = (byte) 0xff;
        assertThatThrownBy(() -> SandboxService.outcome(broken, ""))
            .isInstanceOfSatisfying(SandboxException.class, x -> assertThat(x.reason()).isEqualTo(Reason.NOT_JSON));
        byte[] cut = java.util.Arrays.copyOf("\u00e9".repeat(SandboxService.MAX_OUTCOME_LENGTH).getBytes(StandardCharsets.UTF_8), SandboxService.MAX_OUTCOME_LENGTH * 2 - 1);
        assertThatThrownBy(() -> SandboxService.utf16Length(cut, ""))
            .as("a sequence cut short at the end").isInstanceOf(SandboxException.class);
    }

    /** The cap counts UTF-16 code units from the bytes exactly as String.length() would. */
    @Test
    void theOutcomeIsMeasuredInUtf16UnitsWithoutBuildingTheText() {
        for (String text : new String[] {"", "abc", "\u00e9\u20ac", "\ud83d\ude00x", "a".repeat(20_000) + "\ud83d\ude00".repeat(9_000) + "\u00e9".repeat(7_777)}) {
            assertThat(SandboxService.utf16Length(text.getBytes(StandardCharsets.UTF_8), "")).as(text.length() + " units").isEqualTo(text.length());
        }
        // Past the cap in bytes, under it in units: read in full (4-byte characters are 2 units each).
        String head = "{\"errors\":[],\"pad\":\"";
        String emoji = head + "\ud83d\ude00".repeat(3 * 1024 * 1024) + "\"}";
        assertThat(emoji.getBytes(StandardCharsets.UTF_8).length).isGreaterThan(SandboxService.MAX_OUTCOME_LENGTH);
        assertThat(SandboxService.outcome(emoji.getBytes(StandardCharsets.UTF_8), "").get("pad").stringValue()).hasSize(6 * 1024 * 1024);
    }

    /** Refused before any guest starts: no run, not even the probe. */
    @Test
    void aTooDeepDefinitionStartsNoGuest() {
        FakeRuntime runtime = FakeRuntime.answering("{\"errors\":[]}");
        SandboxService service = service(runtime);
        ObjectNode deep = context();
        deep.set("form", DefinitionDepthTest.nested(41).get("root"));
        assertThatThrownBy(() -> service.validate(deep, List.of(), true))
            .isInstanceOfSatisfying(DefinitionTooDeepException.class, e -> assertThat(e.code()).isEqualTo("definition.tooDeep"));
        assertThatThrownBy(() -> service.inspect("check", DefinitionDepthTest.nested(41), null, null, List.of()))
            .isInstanceOf(DefinitionTooDeepException.class);
        // A journey's own nodes in the context are measured too.
        ObjectNode journeyDeep = context();
        ObjectNode own = JsonNodeFactory.instance.objectNode().put("id", "leaf").put("type", "text");
        for (int i = 1; i <= 33; i++) {
            ObjectNode wrap = JsonNodeFactory.instance.objectNode().put("id", "o" + i).put("type", "columns");
            wrap.set("children", JsonNodeFactory.instance.objectNode().set("content", JsonNodeFactory.instance.arrayNode().add(own)));
            own = wrap;
        }
        ObjectNode page = JsonNodeFactory.instance.objectNode().put("id", "p");
        page.set("components", JsonNodeFactory.instance.arrayNode().add(own));
        ObjectNode journey = JsonNodeFactory.instance.objectNode().put("id", "j");
        journey.set("pages", JsonNodeFactory.instance.arrayNode().add(page));
        journeyDeep.set("journey", journey);
        assertThatThrownBy(() -> service.validate(journeyDeep, List.of(), true)).isInstanceOf(DefinitionTooDeepException.class);
        assertThat(runtime.calls).isEmpty();
        // 32 levels run.
        ObjectNode ok = context();
        ok.set("form", DefinitionDepthTest.nested(32).get("root"));
        service.validate(ok, List.of(), true);
        assertThat(runtime.work()).hasSize(1);
    }

    /** Every slot taken: refused at once with no wait, and nothing runs. */
    @Test
    void busyWhenEverySlotIsTaken() {
        FakeRuntime runtime = FakeRuntime.answering("{\"errors\":[]}");
        RunSlots slots = new RunSlots(1, Duration.ZERO, "validation");
        SandboxService service = service(runtime, slots);
        try (RunSlots.Permit held = slots.acquire()) {
            SandboxException e = failure(() -> service.validate(context(), List.of(), true));
            assertThat(e.reason()).isEqualTo(Reason.BUSY);
            // The wire code the catalog lists for a busy run (conformance suite REC-16).
            assertThat(e.code()).isEqualTo("server.busy");
            assertThat(e.httpStatus()).isEqualTo(503);
            assertThat(e.getMessage()).isEqualTo("Every validation slot (1) is taken.");
        }
        assertThat(runtime.calls).isEmpty();
        service.validate(context(), List.of(), true);
        assertThat(slots.available()).isEqualTo(1);
        // The slot is freed when a run fails too.
        FakeRuntime failing = new FakeRuntime(call -> FakeRuntime.isProbe(call) ? call.framed(FakeRuntime.PROBE_OK) : RunOutput.exited(1, null, null));
        SandboxService failingService = service(failing, slots);
        assertThat(failure(() -> failingService.validate(context(), List.of(), true)).reason()).isEqualTo(Reason.THREW);
        assertThat(slots.available()).isEqualTo(1);
        // A wait that ends with a free slot runs.
        RunSlots waiting = new RunSlots(1, Duration.ofSeconds(1), "validation");
        RunSlots.Permit taken = waiting.acquire();
        Thread release = new Thread(() -> {
            try {
                Thread.sleep(100);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            taken.close();
        });
        release.start();
        service(runtime, waiting).validate(context(), List.of(), true);
        SandboxException waited;
        try (RunSlots.Permit again = waiting.acquire()) {
            waited = failure(() -> service(runtime, waiting).validate(context(), List.of(), true));
        }
        assertThat(waited.getMessage()).isEqualTo("Every validation slot (1) is taken (waited 1 s).");
    }

    /**
     * The inspect ops take the same slots as a validation: with every slot taken an inspection, a builder's check and a
     * public copy are each refused with the same busy answer before anything runs, and a run frees its slot when it ends,
     * answered or not. A check's busy is not turned into the runtime's 503 server.unavailable: it is the busy answer.
     */
    @Test
    void theInspectOpsTakeASlotAndAreBusyWhenEverySlotIsTaken() throws InterruptedException {
        FakeRuntime runtime = new FakeRuntime(call -> {
            if (FakeRuntime.isProbe(call)) {
                return call.framed(FakeRuntime.PROBE_OK);
            }
            String op = call.input().path("op").asString("");
            return call.framed(switch (op) {
                case "check" -> "{\"ok\":true,\"op\":\"check\",\"problems\":[],\"warnings\":[],\"structure\":[],\"structureWarnings\":[],\"verdict\":\"pass\"}";
                case "public" -> "{\"ok\":true,\"op\":\"public\",\"definition\":{\"id\":\"f\",\"root\":{\"id\":\"root\"}}}";
                default -> "{\"ok\":true,\"op\":\"inspect\",\"rules\":[]}";
            });
        });
        RunSlots slots = new RunSlots(1, Duration.ZERO, "validation");
        SandboxService service = service(runtime, slots);
        ObjectNode secret = DefinitionDepthTest.nested(3);
        secret.set("rules", JsonNodeFactory.instance.arrayNode().add(JsonNodeFactory.instance.objectNode().put("scope", "server-secret")));
        List<Runnable> ops = List.of(
            () -> service.inspect("inspect", DefinitionDepthTest.nested(3)),
            () -> service.inspect("inspect", DefinitionDepthTest.nested(3), "warn", null, List.of()),
            () -> service.check(DefinitionDepthTest.nested(3), List.of("text"), List.of()),
            () -> service.publicCopy(secret));
        try (RunSlots.Permit held = slots.acquire()) {
            for (Runnable op : ops) {
                SandboxException e = failure(op);
                assertThat(e.reason()).isEqualTo(Reason.BUSY);
                assertThat(e.code()).isEqualTo("server.busy");
                assertThat(e.httpStatus()).isEqualTo(503);
                assertThat(e.getMessage()).isEqualTo("Every validation slot (1) is taken.");
            }
            // The depth guard still comes first: a definition too deep is the caller's, slot or no slot.
            assertThatThrownBy(() -> service.inspect("inspect", DefinitionDepthTest.nested(41))).isInstanceOf(DefinitionTooDeepException.class);
        }
        assertThat(runtime.calls).as("nothing ran while the slot was taken").isEmpty();
        for (Runnable op : ops) {
            op.run();
            assertThat(slots.available()).as("the slot is freed after the run").isEqualTo(1);
        }
        assertThat(runtime.work()).hasSize(4);
        // A run that gave no answer frees its slot too.
        SandboxService broken = service(FakeRuntime.answering("{nope"), slots);
        assertThat(failure(() -> broken.inspect("inspect", DefinitionDepthTest.nested(3))).reason()).isEqualTo(Reason.NOT_JSON);
        assertThat(slots.available()).isEqualTo(1);
        // A run in flight holds the slot: a second caller is busy until it ends.
        java.util.concurrent.CountDownLatch inside = new java.util.concurrent.CountDownLatch(1);
        java.util.concurrent.CountDownLatch release = new java.util.concurrent.CountDownLatch(1);
        SandboxService holding = service(new FakeRuntime(call -> {
            if (FakeRuntime.isProbe(call)) {
                return call.framed(FakeRuntime.PROBE_OK);
            }
            inside.countDown();
            try {
                release.await();
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            return call.framed("{\"ok\":true,\"op\":\"inspect\",\"rules\":[]}");
        }), slots);
        Thread first = new Thread(() -> holding.inspect("inspect", DefinitionDepthTest.nested(3)));
        first.start();
        try {
            assertThat(inside.await(5, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
            assertThat(slots.available()).isZero();
            assertThat(failure(() -> service.inspect("inspect", DefinitionDepthTest.nested(3))).reason()).isEqualTo(Reason.BUSY);
            assertThat(failure(() -> service.validate(context(), List.of(), true)).reason()).isEqualTo(Reason.BUSY);
        } finally {
            release.countDown();
        }
        first.join(5000);
        assertThat(slots.available()).isEqualTo(1);
    }

    @Test
    void theRunLogGoesToTheLoggerEntryByEntry() {
        FakeRuntime runtime = FakeRuntime.answering("{\"errors\":[],\"logs\":[{\"level\":\"debug\",\"message\":\"opened\",\"data\":{\"fields\":1}},"
            + "{\"level\":\"warn\",\"message\":\"two\\nlines\"},\"not an entry\",{\"level\":\"error\"}]}");
        service(runtime).validate(context(), List.of(), true);
        assertThat(logged).hasSize(3);
        assertThat(logged.get(0)).containsExactly("f", "debug", "opened", "{\"fields\":1}");
        assertThat(logged.get(1)).containsExactly("f", "warn", "two\nlines", null);
        assertThat(logged.get(2)).containsExactly("f", "error", "", null);
        assertThat(RunLog.oneLine("two\nlines\r\u2028")).isEqualTo("two\\nlines\\r\\u2028");
    }

    /**
     * The log is an observer: an application's RunLog whose sink is down throws on every entry, yet
     * the verdict comes back as the kernel gave it, and every entry was still offered.
     */
    @Test
    void aRunLogThatThrowsNeverChangesTheVerdict() {
        List<String> offered = new ArrayList<>();
        RunLog down = (form, level, message, data) -> {
            offered.add(message);
            throw new IllegalStateException("audit table unavailable: " + message);
        };
        SandboxService service = new SandboxService(FakeRuntime.answering(
            "{\"errors\":[],\"logs\":[{\"level\":\"info\",\"message\":\"one\"},{\"level\":\"warn\",\"message\":\"two\"}]}"),
            PROGRAM, SCRIPTS, ProgramLimits.defaults(), HOST, new RunSlots(2, Duration.ZERO, "validation"), new AbiProbe(), down, null);
        SandboxResult result = service.validate(context(), List.of(), true);
        assertThat(result.outcome().get("errors").isEmpty()).isTrue();
        assertThat(offered).containsExactly("one", "two");
    }

    /** SubmissionReceiver relays the log only for a real submission: a dry run and the smoke run log nothing. */
    @Test
    void onlyARealSubmissionRelaysItsRunLog() {
        String answer = "{\"errors\":[{\"code\":\"required\",\"componentId\":\"name\"}],\"logs\":[{\"level\":\"info\",\"message\":\"value 42\"}]}";
        service(FakeRuntime.answering(answer)).validate(context(), List.of(), false);
        assertThat(logged).isEmpty();
        assertThat(service(FakeRuntime.answering(answer)).smoke().ok()).isTrue();
        assertThat(logged).isEmpty();
        service(FakeRuntime.answering(answer)).validate(context(), List.of(), true);
        assertThat(logged).hasSize(1);
    }

    /** One entry is one line: no control character of the guest's reaches the log as it is. */
    @Test
    void theRunLogEscapesEveryControlCharacter() {
        assertThat(RunLog.oneLine("plain text \u00e9 \ud83d\ude00")).isEqualTo("plain text \u00e9 \ud83d\ude00");
        assertThat(RunLog.oneLine("ok\u001b[2K\u001b[1Gadmin login succeeded"))
            .isEqualTo("ok\\u001b[2K\\u001b[1Gadmin login succeeded");
        assertThat(RunLog.oneLine("a\u0085b\u000bc\u000cd\u0000e\tf\u007fg\u009bh\u2029i\\j"))
            .isEqualTo("a\\u0085b\\u000bc\\u000cd\\u0000e\\u0009f\\u007fg\\u009bh\\u2029i\\\\j");
        for (char c = 0; c < 0xa0; c++) {
            if (Character.isISOControl(c)) {
                assertThat(RunLog.oneLine("x" + c + "y")).as("U+%04X", (int) c).doesNotContain(String.valueOf(c));
            }
        }
    }

    @Test
    void inspectAsksWithTheFloorAndReadsARefusalAsItsCode() {
        FakeRuntime runtime = FakeRuntime.answering("{\"ok\":true,\"op\":\"inspect\",\"rules\":[]}");
        SandboxService service = service(runtime);
        ObjectNode answer = service.inspect("inspect", DefinitionDepthTest.nested(3), "warn", null, List.of());
        assertThat(answer.get("op").stringValue()).isEqualTo("inspect");
        JsonNode request = runtime.work().get(0).input();
        assertThat(request.get("abi").stringValue()).isEqualTo("1.0.0");
        assertThat(request.get("op").stringValue()).isEqualTo("inspect");
        assertThat(request.get("formulaErrors").stringValue()).isEqualTo("warn");
        assertThat(request.get("definition").get("id").stringValue()).isEqualTo("f");
        assertThat(runtime.work().get(0).script()).contains("var entry = globalThis.__datum_inspect;");

        FakeRuntime refusing = FakeRuntime.answering("{\"ok\":false,\"error\":{\"code\":\"invalid_request\",\"message\":\"guest words\"}}");
        SandboxException refused = failure(() -> service(refusing).inspect("public", DefinitionDepthTest.nested(3), null, null, List.of()));
        assertThat(refused.reason()).isEqualTo(Reason.REFUSED);
        assertThat(refused.programCode()).isEqualTo("invalid_request");
        assertThat(refused.programMessage()).isEqualTo("guest words");
        assertThat(refused.getMessage()).isEqualTo("The sandbox refused the public request (invalid_request).").doesNotContain("guest words");
        assertThat(failure(() -> service(FakeRuntime.answering("{\"ok\":\"yes\"}")).inspect("inspect", DefinitionDepthTest.nested(3), null, null, List.of())).reason())
            .isEqualTo(Reason.NO_OUTCOME);
        assertThat(failure(() -> service(FakeRuntime.answering("{nope")).inspect("inspect", DefinitionDepthTest.nested(3), null, null, List.of())).reason())
            .isEqualTo(Reason.NOT_JSON);
        // An inspect answer is not held to the outcome cap.
        String big = "{\"ok\":true,\"pad\":\"" + "x".repeat(SandboxService.MAX_OUTCOME_LENGTH) + "\"}";
        assertThat(service(FakeRuntime.answering(big)).inspect("inspect", DefinitionDepthTest.nested(3), null, null, List.of()).has("pad")).isTrue();
    }

    @Test
    void checkSendsTheHostsPoliciesAndSortedTypes() {
        FakeRuntime runtime = FakeRuntime.answering("{\"ok\":true,\"op\":\"check\",\"problems\":[],\"warnings\":[],\"structure\":[],\"structureWarnings\":[],\"verdict\":\"pass\"}");
        ObjectNode answer = service(runtime).check(DefinitionDepthTest.nested(3), List.of("text", "form", "group"), List.of(new RuleModule("p", "1", "({})")));
        assertThat(answer.get("verdict").stringValue()).isEqualTo("pass");
        JsonNode request = runtime.work().get(0).input();
        assertThat(request.get("op").stringValue()).isEqualTo("check");
        assertThat(request.get("formulaErrors").stringValue()).isEqualTo("warn");
        assertThat(request.get("riskyPatterns").stringValue()).isEqualTo("allow");
        assertThat(request.get("types").toString()).isEqualTo("[\"form\",\"group\",\"text\"]");
        assertThat(runtime.work().get(0).script()).contains("register(evaluate(");
        // Every caller decides the type list (always sent, so the program can report component.type.unknown, DEF-08):
        // none is a choice, sent as [].
        assertThatThrownBy(() -> service(runtime).check(DefinitionDepthTest.nested(3), null, List.of())).isInstanceOf(NullPointerException.class);
        service(runtime).check(DefinitionDepthTest.nested(3), List.of(), List.of());
        assertThat(runtime.work().get(1).input().get("types").toString()).isEqualTo("[]");
        assertThat(runtime.work().get(1).input().get("riskyPatterns").stringValue()).isEqualTo("allow");
        // No structure listed: fail closed, never "no problems", and the runtime's fault (the save routes' 503).
        assertThatThrownBy(() -> service(FakeRuntime.answering("{\"ok\":true,\"op\":\"check\",\"problems\":[]}"))
            .check(DefinitionDepthTest.nested(3), List.of(), List.of()))
            .isInstanceOfSatisfying(ProgramUnavailableException.class, e -> {
                assertThat(e.code()).isEqualTo("server.unavailable");
                assertThat(e.httpStatus()).isEqualTo(503);
                assertThat(((SandboxException) e.getCause()).reason()).isEqualTo(Reason.NO_OUTCOME);
                assertThat(e.getCause().getMessage()).contains("listed no structure");
            });
    }

    /**
     * The save routes' rule (a runtime outage refuses the save): a check that gave no verdict for any reason but the
     * definition's is 503 server.unavailable, never a 422 that blames the author.
     */
    @Test
    void aCheckThatFailedForTheRuntimesReasonsIsUnavailable() {
        Function<Function<FakeRuntime.Call, RunOutput>, FakeRuntime> guest = work -> new FakeRuntime(call -> FakeRuntime.isProbe(call)
            ? call.framed(FakeRuntime.PROBE_OK) : work.apply(call));
        record Case(Reason reason, Function<FakeRuntime.Call, RunOutput> work) {
        }
        for (Case c : List.of(
            new Case(Reason.THREW, call -> RunOutput.exited(1, null, "TypeError".getBytes(StandardCharsets.UTF_8))),
            new Case(Reason.NOT_JSON, call -> call.framed("{nope")),
            new Case(Reason.REFUSED, call -> call.framed("{\"ok\":false,\"error\":{\"code\":\"invalid_request\",\"message\":\"m\"}}")),
            new Case(Reason.OUTPUT_CAP, call -> new RunOutput(Termination.OUTPUT_CAP, 0, null, null, null)),
            new Case(Reason.TRAP, call -> new RunOutput(Termination.TRAP, 0, (Frame.marker(call.nonce(), "started") + "\n").getBytes(StandardCharsets.UTF_8), null, "unreachable")),
            new Case(Reason.BUDGET, call -> new RunOutput(Termination.BUDGET, 0, null, null, null)),
            // A stuck check is never the definition's cost, even with its started marker out.
            new Case(Reason.BUDGET, call -> new RunOutput(Termination.STUCK, -1, (Frame.marker(call.nonce(), "started") + "\n").getBytes(StandardCharsets.UTF_8), null, null)),
            new Case(Reason.INTERRUPTED, call -> new RunOutput(Termination.INTERRUPTED, 0, null, null, null)))) {
            assertThatThrownBy(() -> service(guest.apply(c.work())).check(DefinitionDepthTest.nested(3), List.of(), List.of()))
                .as(c.reason().name())
                .isInstanceOfSatisfying(ProgramUnavailableException.class, e -> {
                    assertThat(e.code()).isEqualTo("server.unavailable");
                    assertThat(e.httpStatus()).isEqualTo(503);
                    assertThat(e.getCause()).isInstanceOfSatisfying(SandboxException.class, x -> assertThat(x.reason()).isEqualTo(c.reason()));
                    assertThat(e.getMessage()).doesNotContain("TypeError").doesNotContain("invalid_request");
                });
        }
        // Too deep stays the author's 422, before any guest starts.
        FakeRuntime runtime = FakeRuntime.answering("{}");
        assertThatThrownBy(() -> service(runtime).check(DefinitionDepthTest.nested(41), List.of(), List.of()))
            .isInstanceOfSatisfying(DefinitionTooDeepException.class, e -> assertThat(e.httpStatus()).isEqualTo(422));
        assertThat(runtime.calls).isEmpty();
    }

    /** DefinitionVerdictTest: a check stopped at its own limit is the definition's fault; nothing else is. */
    @Test
    void aCheckStoppedAtItsOwnLimitIsTooCostly() {
        Function<Termination, FakeRuntime> stopping = stop -> new FakeRuntime(call -> FakeRuntime.isProbe(call)
            ? call.framed(FakeRuntime.PROBE_OK)
            : new RunOutput(stop, 0, (Frame.marker(call.nonce(), "started") + "\n").getBytes(StandardCharsets.UTF_8), "stderr text".getBytes(StandardCharsets.UTF_8), null));
        for (Termination stop : new Termination[] {Termination.BUDGET, Termination.MEMORY}) {
            SandboxException e = failure(() -> service(stopping.apply(stop)).check(DefinitionDepthTest.nested(3), List.of(), List.of()));
            assertThat(e.typedCode()).isEqualTo("definition.tooCostly");
            assertThat(e.code()).isEqualTo("definition.tooCostly");
            assertThat(e.httpStatus()).isEqualTo(422);
            assertThat(e.getCause()).isInstanceOf(SandboxException.class);
            assertThat(e.stderr()).isEqualTo("stderr text");
            assertThat(SandboxService.classifyCheck(e)).as("typed once").isSameAs(e);
        }
        // The host's own stops, and every other failure, stay what they were.
        for (SandboxException other : new SandboxException[] {
            new SandboxException(Reason.BUDGET, "The sandbox run passed its 5 s budget."),
            new SandboxException(Reason.OUTPUT_CAP, "The sandbox run wrote more than its output limit.", "x", false),
            new SandboxException(Reason.THREW, "threw"),
            new SandboxException(Reason.TRAP, "trapped")}) {
            assertThat(SandboxService.classifyCheck(other)).isSameAs(other);
        }
        // A budget stop before the program started is not the definition's: the runtime's 503.
        FakeRuntime early = new FakeRuntime(call -> FakeRuntime.isProbe(call) ? call.framed(FakeRuntime.PROBE_OK) : new RunOutput(Termination.BUDGET, 0, null, null, null));
        assertThatThrownBy(() -> service(early).check(DefinitionDepthTest.nested(3), List.of(), List.of()))
            .isInstanceOfSatisfying(ProgramUnavailableException.class, e -> {
                SandboxException cause = (SandboxException) e.getCause();
                assertThat(cause.typedCode()).isNull();
                assertThat(cause.reason()).isEqualTo(Reason.BUDGET);
                assertThat(cause.guestStopped()).isFalse();
            });
    }

    @Test
    void aPublicCopyCostsARunOnlyWhenThereIsASecretRule() {
        FakeRuntime runtime = FakeRuntime.answering("{\"ok\":true,\"op\":\"public\",\"definition\":{\"id\":\"f\",\"root\":{\"id\":\"root\"}}}");
        SandboxService service = service(runtime);
        ObjectNode plain = DefinitionDepthTest.nested(3);
        ObjectNode copy = service.publicCopy(plain);
        assertThat(copy).isEqualTo(plain).isNotSameAs(plain);
        assertThat(runtime.calls).isEmpty();
        ObjectNode secret = DefinitionDepthTest.nested(3);
        secret.set("rules", JsonNodeFactory.instance.arrayNode().add(JsonNodeFactory.instance.objectNode().put("scope", "server-secret")));
        assertThat(service.publicCopy(secret).get("root").get("id").stringValue()).isEqualTo("root");
        assertThat(runtime.work().get(0).input().get("op").stringValue()).isEqualTo("public");
        assertThat(failure(() -> service(FakeRuntime.answering("{\"ok\":true,\"op\":\"public\"}")).publicCopy(secret)).reason())
            .isEqualTo(Reason.NO_OUTCOME);
    }

    @Test
    void smoke() {
        SandboxService.Smoke ok = service(FakeRuntime.answering("{\"errors\":[{\"code\":\"required\",\"componentId\":\"name\"}]}")).smoke();
        assertThat(ok.ok()).isTrue();
        assertThat(ok.message()).isEqualTo("The sandbox answered as expected.");
        FakeRuntime runtime = FakeRuntime.answering("{\"errors\":[]}");
        assertThat(service(runtime).smoke().ok()).isFalse();
        JsonNode context = runtime.work().get(0).input();
        assertThat(context.get("formId").stringValue()).isEqualTo("datum-smoke");
        assertThat(service(new FakeRuntime(call -> RunOutput.exited(127, null, null))).smoke().ok()).isFalse();
    }

    /** A number JSON cannot write is refused before any run. */
    @Test
    void anUnwritableContextIsRefusedBeforeTheRun() {
        FakeRuntime runtime = FakeRuntime.answering("{\"errors\":[]}");
        SandboxService service = service(runtime);
        service.proveAbi();
        ObjectNode context = context();
        ((ObjectNode) context.get("values")).put("n", Double.POSITIVE_INFINITY);
        SandboxException e = failure(() -> service.validate(context, List.of(), true));
        assertThat(e.reason()).isEqualTo(Reason.INPUT);
        assertThat(runtime.work()).isEmpty();
    }

    /** A runtime that let the cap's exception out still ends the run as an output-cap refusal. */
    @Test
    void anEscapedCapExceptionIsTheOutputCap() {
        FakeRuntime runtime = new FakeRuntime(call -> {
            if (FakeRuntime.isProbe(call)) {
                return call.framed(FakeRuntime.PROBE_OK);
            }
            throw new OutputCapExceededException("stdout", Budget.STDOUT_LIMIT);
        });
        assertThat(failure(() -> service(runtime).validate(context(), List.of(), true)).reason()).isEqualTo(Reason.OUTPUT_CAP);
    }

    @Test
    void theProgramMustBeTheSandboxOne() {
        Program pdf = Program.of(Program.Kind.PDF, new byte[] {1});
        assertThatThrownBy(() -> new SandboxService(FakeRuntime.answering("{}"), pdf, SCRIPTS, ProgramLimits.defaults(), HOST,
            new RunSlots(1, Duration.ZERO, "validation"), new AbiProbe(), RunLog.slf4j(), null)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void aProgramIsItsBytesAndTheirHash() {
        byte[] bytes = "abc".getBytes(StandardCharsets.UTF_8);
        Program program = Program.of(Program.Kind.SANDBOX, bytes);
        assertThat(program.sha256()).isEqualTo("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        bytes[0] = 'x';
        assertThat(program.bytes()[0]).isEqualTo((byte) 'a');
        program.bytes()[0] = 'y';
        assertThat(program.bytes()[0]).isEqualTo((byte) 'a');
        assertThat(program.buffer().isReadOnly()).isTrue();
        assertThatThrownBy(() -> new Program(Program.Kind.SANDBOX, "abc".getBytes(StandardCharsets.UTF_8), "00".repeat(32)))
            .isInstanceOf(IllegalArgumentException.class);
        assertThat(new Program(Program.Kind.SANDBOX, "abc".getBytes(StandardCharsets.UTF_8), program.sha256().toUpperCase())).isEqualTo(program);
        assertThat(AbiProbe.key(program, SandboxAbi.MIN)).isEqualTo(program.sha256() + "|1.0.0");
    }
}
