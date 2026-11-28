package com.argusvane.datum.sandbox.tck;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.catchThrowable;
import static org.assertj.core.api.Assertions.catchThrowableOfType;

import com.argusvane.datum.core.DefinitionTooDeepException;
import com.argusvane.datum.core.ProgramUnavailableException;
import com.argusvane.datum.sandbox.protocol.AbiProbe;
import com.argusvane.datum.sandbox.wasi.Budget;
import com.argusvane.datum.sandbox.wasi.GuestRuntime;
import com.argusvane.datum.sandbox.wasi.RunOutput;
import com.argusvane.datum.sandbox.wasi.Termination;
import com.argusvane.datum.sandbox.protocol.HostOptions;
import com.argusvane.datum.sandbox.protocol.Program;
import com.argusvane.datum.sandbox.protocol.ProgramLimits;
import com.argusvane.datum.sandbox.protocol.ProgramRunner;
import com.argusvane.datum.sandbox.protocol.RuleModule;
import com.argusvane.datum.sandbox.protocol.RunLog;
import com.argusvane.datum.sandbox.protocol.RunScript;
import com.argusvane.datum.sandbox.protocol.RunSlots;
import com.argusvane.datum.sandbox.protocol.SandboxAbi;
import com.argusvane.datum.sandbox.protocol.SandboxException;
import com.argusvane.datum.sandbox.protocol.SandboxException.Reason;
import com.argusvane.datum.sandbox.protocol.SandboxResult;
import com.argusvane.datum.sandbox.protocol.SandboxService;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.time.Duration;
import java.util.Optional;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;
import tools.jackson.databind.node.ObjectNode;

/**
 * The sandbox hardening on the engine, through {@link SandboxService} with the real program: the hardening of the WASM sandbox
 * (the ABI gate, a rule module that cannot forge, rebind or write outside the
 * frame, thrown words, the depth guard) plus the budget, memory and trap stops. The conformance
 * suite checks the HTTP subset of these on a packaged host (HRD-01..04: the budget, memory, the output cap, a forged
 * frame).
 *
 * <p>Not here, because the JVM side has no counterpart: the probe running the proved bytes (a {@link Program} is an
 * immutable copy hashed at construction, and {@link RuntimeContract} proves the guest reads exactly those bytes); a
 * precompiled-module cache; the ABI gate's stored state (the proof lives in {@link AbiProbe}).
 */
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
public interface SandboxHardeningContract extends RuntimeUnderTest {

    /**
     * Two tests below stop a looping rule at a 2 s budget and need its started marker within it. In a cold JVM the first
     * runs miss that (BUDGET before the marker twice, then tooCostly), and the class may run first in
     * its fork, so it warms the engine itself: three raw runs, then a full sandbox run.
     */
    @BeforeAll
    default void warmUpTheEngineForTheTwoSecondBudgets() {
        for (int i = 0; i < 3; i++) {
            runtime().run(ProgramRunner.guestRun(RuntimeTckAssets.sandboxProgram(), "print(1);", List.of("qjs", "--std", "/app/run.js"), new byte[0],
                new Budget(30, 32L << 20, Budget.STDOUT_LIMIT, Budget.STDERR_LIMIT)));
        }
        realService(ProgramLimits.builder().validationSeconds(30).build()).proveAbi();
    }

    /** A one-field context. */
    private static ObjectNode context(String name) {
        ObjectNode context = (ObjectNode) RuntimeTckAssets.JSON.readTree("{\"formId\":\"t\",\"form\":{\"id\":\"root\",\"type\":\"form\","
            + "\"configuration\":{},\"children\":{\"content\":[{\"id\":\"name\",\"type\":\"text\",\"configuration\":"
            + "{\"label\":\"Name\",\"required\":true}}]}},\"values\":{},\"locale\":\"en\"}");
        if (name != null) {
            ((ObjectNode) context.get("values")).put("name", name);
        }
        return context;
    }

    /**
     * A stand-in program that answers for an ABI and a fixed run answer. Its {@code __datum_inspect} refuses a request
     * naming an ABI newer than its own, as the real one does.
     */
    private static Program fakeProgram(String abi, String answer) {
        String source = "globalThis.__datum_register = function () { return 0; };"
            + "globalThis.__datum_run = function () { return " + answer + "; };"
            + "globalThis.__datum_inspect = function (r) { var q = JSON.parse(r); var a = q.abi.split(\".\").map(Number); var p = \"" + abi + "\".split(\".\").map(Number);"
            + " return JSON.stringify(a[0] === p[0] && a[1] <= p[1] ? { ok: true, op: q.op } : { ok: false, error: { code: \"abi_mismatch\", message: \"older program\" } }); };"
            + "\"sandbox-ready\";";
        return Program.of(Program.Kind.SANDBOX, source.getBytes(StandardCharsets.UTF_8));
    }

    private static Program fakeProgram(String abi) {
        return fakeProgram(abi, "JSON.stringify({ errors: [] })");
    }

    private static SandboxService service(ProgramRunner on, Program program, ProgramLimits limits, AbiProbe probe) {
        return new SandboxService(on, program, RuntimeTckAssets.scripts(), limits, HostOptions.defaults(), RunSlots.validation(limits), probe,
            RunLog.slf4j(), null);
    }

    private SandboxService realService(ProgramLimits limits) {
        return service(ProgramRunner.on(runtime()), RuntimeTckAssets.sandboxProgram(), limits, new AbiProbe());
    }

    private static List<RuleModule> rule(String id, String source) {
        return List.of(new RuleModule(id, "1", source));
    }

    private static List<String> codes(SandboxResult result) {
        List<String> codes = new ArrayList<>();
        result.outcome().path("errors").values().forEach(error -> codes.add(error.path("code").asString("")));
        return codes;
    }

    /** A program that is older than the floor is never used. */
    @Test
    default void aProgramBelowTheFloorIsRefused() {
        AbiProbe probe = new AbiProbe();
        Program stale = fakeProgram("0.9.0");
        SandboxService service = service(ProgramRunner.on(runtime()), stale, ProgramLimits.defaults(), probe);
        for (int attempt = 0; attempt < 2; attempt++) {
            assertThatThrownBy(() -> service.validate(context("Ada"), List.of(), false))
                .as("a 503 for the submitter, not a verdict")
                .isInstanceOf(ProgramUnavailableException.class)
                .hasMessageContaining("abi_mismatch");
        }
        assertThat(probe.sandboxProved(stale)).as("a refusal is not remembered").isFalse();
        ObjectNode definition = RuntimeTckAssets.JSON.createObjectNode();
        definition.put("id", "x");
        definition.set("root", context(null).get("form"));
        assertThatThrownBy(() -> service.inspect("check", definition)).as("inspect goes through the gate as well")
            .isInstanceOf(ProgramUnavailableException.class);
    }

    /** A program at the floor passes; the proof is kept for that program's bytes only. */
    @Test
    default void theProofIsKeptPerProgram() {
        AbiProbe probe = new AbiProbe();
        Program good = fakeProgram(SandboxAbi.MIN);
        SandboxService service = service(ProgramRunner.on(runtime()), good, ProgramLimits.defaults(), probe);
        assertThat(codes(service.validate(context("Ada"), List.of(), false))).isEmpty();
        assertThat(probe.sandboxProved(good)).isTrue();
        assertThat(codes(service.validate(context("Ada"), List.of(), false))).isEmpty();
        // The program is replaced by an older one: proved again, and refused.
        SandboxService replaced = service(ProgramRunner.on(runtime()), fakeProgram("0.9.0"), ProgramLimits.defaults(), probe);
        assertThatThrownBy(() -> replaced.validate(context("Ada"), List.of(), false)).isInstanceOf(ProgramUnavailableException.class);
    }

    /**
     * A rule module has no stdout, stdin, std or os, and none of the globals quickjs-ng adds beyond the page's engine
     * (queueMicrotask, gc, navigator, argv0, execArgv, atob, btoa, DOMException): it reaches what it would reach in the
     * browser.
     */
    @Test
    default void aRuleModuleCannotForgeAnOutcome() {
        SandboxService service = realService(ProgramLimits.defaults());
        String probe = "(function () { var seen = []; "
            + "['std','os','print','console','performance','scriptArgs','bjson','queueMicrotask','gc','navigator','argv0','execArgv',"
            + "'atob','btoa','DOMException'].forEach(function (n) { if (n in globalThis || typeof globalThis[n] !== 'undefined') { seen.push(n); } }); "
            + "globalThis.__datum_run = function () { return JSON.stringify({ errors: [], forged: true }); }; "
            + "return { validators: [function () { return { errors: seen.map(function (n) { return { code: 'leak.' + n, componentId: 'name', message: n }; }) }; }] }; })()";
        SandboxResult result = service.validate(context("Ada"), rule("probe", probe), false);
        assertThat(codes(result)).as("no global is left for a rule to reach").isEmpty();
        assertThat(result.outcome().has("forged")).as("replacing __datum_run changes nothing: the entry point was kept first").isFalse();
        assertThat(result.outcome().path("values").path("name").asString("")).isEqualTo("Ada");

        // print, std and console are not there to call.
        for (String source : List.of(
            "(print('{\"errors\":[],\"forged\":true}'), std.exit(0), { validators: [] })",
            "(console.log('x'), { validators: [] })",
            "(std.out.puts('x'), { validators: [] })")) {
            SandboxException e = catchThrowableOfType(SandboxException.class,
                () -> service.validate(context("Ada"), rule("evil", source), false));
            assertThat(e).as("a module that reaches for print, console or std throws while it loads: " + source).isNotNull();
            assertThat(e.reason()).isEqualTo(Reason.THREW);
            assertThat(e.stderr()).contains("ReferenceError");
        }
    }

    /** A rule module cannot rebind the kernel or patch an intrinsic. */
    @Test
    default void aRuleModuleCannotRebindTheKernel() {
        String poison = "(function () { globalThis.kernelIsEmptyValue = function () { return false; }; "
            + "Array.prototype.some = function () { return false; }; Object.prototype.polluted = 1; "
            + "return { validators: [function () { return { errors: [] }; }] }; })()";
        SandboxResult result = realService(ProgramLimits.defaults()).validate(context(""), rule("poison", poison), false);
        assertThat(codes(result)).as("the empty required answer is still refused").containsExactly("required");
    }

    /**
     * run.js hands every rule module its source exactly as written, whatever its characters (a trailing line comment,
     * quotes, a backslash, U+2028, a character past the BMP), and registers the modules in their order: what
     * RunScript's text tests cannot show (run.js is checked by
     * running it).
     */
    @Test
    default void ruleSourcesAreEvaluatedAsWrittenAndInOrder() {
        String text = "é 😀   \"quoted\" \\ back";
        String literal = RuntimeTckAssets.JSON.writeValueAsString(text);
        List<RuleModule> rules = List.of(
            new RuleModule("first", "1", "({ validators: [function () { return { errors: [{ code: 'first', componentId: 'name', message: "
                + literal + " }] }; }] }) // a trailing line comment"),
            new RuleModule("second", "1",
                "({ validators: [function () { return { errors: [{ code: 'second', componentId: 'name', message: 'two' }] }; }] })"));
        SandboxResult result = realService(ProgramLimits.defaults()).validate(context("Ada"), rules, false);
        assertThat(codes(result)).containsExactly("first", "second");
        assertThat(result.outcome().path("errors").get(0).path("message").asString("")).isEqualTo(text);
    }

    /** A module that reaches stdout through qjs:std after the frame is refused. */
    @Test
    default void bytesWrittenOutsideTheFrameRefuseTheRun() {
        SandboxService service = realService(ProgramLimits.defaults());
        String source = "(import('qjs:std').then(function (m) { m.out.puts('INJECTED-LINE\\n'); m.out.flush(); }), { validators: [] })";
        SandboxException e = catchThrowableOfType(SandboxException.class, () -> service.validate(context("Ada"), rule("evil", source), false));
        assertThat(e).as("stray stdout bytes refuse the run").isNotNull();
        assertThat(e.reason()).isEqualTo(Reason.FRAME);
        assertThat(e.getMessage()).contains("outside its answer frame");
        // Bytes that only look like whitespace are stray too: the frame allows JSON's whitespace and nothing else.
        String blank = "(import('qjs:std').then(function (m) { m.out.puts('\\0\\0\\v'); m.out.flush(); }), { validators: [] })";
        SandboxException quiet = catchThrowableOfType(SandboxException.class, () -> service.validate(context("Ada"), rule("blank", blank), false));
        assertThat(quiet).as("a NUL or a vertical tab after the frame refuses the run").isNotNull();
        assertThat(quiet.reason()).isEqualTo(Reason.FRAME);
        // A module that stays quiet still runs.
        assertThat(codes(service.validate(context("Ada"), rule("quiet", "({ validators: [] })"), false))).isEmpty();
    }

    /** A thrown message with words that resemble a stop stays a failed run. */
    @Test
    default void thrownWordsDoNotMakeTheRuntimeUnavailable() {
        SandboxService service = realService(ProgramLimits.defaults());
        for (String words : List.of("No such file attacker", "failed deserialization", "wasm trap: interrupt")) {
            Throwable thrown = catchThrowableOfType(RuntimeException.class,
                () -> service.validate(context("Ada"), rule("t", "(() => { throw new Error('" + words + "'); })()"), false));
            assertThat(thrown).as("never unavailable: " + words).isInstanceOf(SandboxException.class);
            assertThat(((SandboxException) thrown).reason()).isIn(Reason.THREW, Reason.BUDGET);
        }
    }

    /** A run that writes past the output cap is stopped: a 40 MiB answer against the 32 MiB cap. */
    @Test
    default void outputIsCapped() {
        ProgramLimits roomy = ProgramLimits.builder().validationMemory(512L * 1024 * 1024).validationSeconds(20).build();
        SandboxService service = service(ProgramRunner.on(runtime()), fakeProgram(SandboxAbi.MIN, "\"x\".repeat(40 * 1024 * 1024)"), roomy, new AbiProbe());
        SandboxException e = catchThrowableOfType(SandboxException.class, () -> service.validate(context("Ada"), List.of(), false));
        assertThat(e).isNotNull();
        assertThat(e.reason()).isEqualTo(Reason.OUTPUT_CAP);
        assertThat(e.getMessage()).contains("output limit");
        assertThat(e.guestStopped()).as("the cap proves nothing about the definition").isFalse();
    }

    /** A definition nested past 32 levels is refused before the guest starts. */
    @Test
    default void aTooDeepDefinitionIsRefusedBeforeTheRun() {
        AtomicInteger runs = new AtomicInteger();
        ProgramRunner counting = (program, script, argv, stdin, budget) -> {
            runs.incrementAndGet();
            return ProgramRunner.on(runtime()).run(program, script, argv, stdin, budget);
        };
        SandboxService service = service(counting, RuntimeTckAssets.sandboxProgram(), ProgramLimits.defaults(), new AbiProbe());
        String leaf = "{\"id\":\"leaf\",\"type\":\"text\",\"configuration\":{}}";
        String node = leaf;
        for (int i = 1; i <= 40; i++) {
            node = "{\"id\":\"g" + i + "\",\"type\":\"container\",\"configuration\":{},\"children\":{\"content\":[" + node + "]}}";
        }
        ObjectNode context = context("Ada");
        context.set("form", RuntimeTckAssets.JSON.readTree("{\"id\":\"root\",\"type\":\"form\",\"configuration\":{},\"children\":{\"content\":[" + node + "]}}"));
        assertThatThrownBy(() -> service.validate(context, List.of(), false)).isInstanceOf(DefinitionTooDeepException.class);
        assertThat(runs).as("no guest started, not even the ABI probe").hasValue(0);
    }

    /** A looping validator is stopped at the budget, as the guest's own stop, and the next run answers. */
    @Test
    default void aLoopingValidatorIsStoppedAtTheBudgetAndTheNextRunAnswers() {
        SandboxService service = realService(ProgramLimits.builder().validationSeconds(2).build());
        service.proveAbi();
        long started = System.nanoTime();
        SandboxException e = catchThrowableOfType(SandboxException.class,
            () -> service.validate(context("Ada"), rule("loop", "({ validators: [function () { for (;;) {} }] })"), false));
        double seconds = (System.nanoTime() - started) / 1e9;
        assertThat(e).isNotNull();
        assertThat(e.reason()).isEqualTo(Reason.BUDGET);
        assertThat(e.guestStopped()).as("the started marker was handed back with the stop").isTrue();
        assertThat(seconds).isLessThan(2 + stopGrace().toSeconds());
        assertThat(codes(service.validate(context("Ada"), List.of(), false))).isEmpty();
    }

    /**
     * The engine's stray bound, seen through the protocol: a run stopped at its budget whose thread
     * outlives the grace holds a stray, and past the bound the next run through {@link ProgramRunner} is the protocol's
     * {@link ProgramUnavailableException} (503 {@code server.unavailable}), the engine's refusal translated once.
     */
    @Test
    default void theStrayBoundIsTheProtocolsServiceUnavailable() throws Exception {
        CountDownLatch hold = new CountDownLatch(1);
        Optional<GuestRuntime> holding = holdingRuntime(Duration.ofMillis(200), 1, hold);
        Assumptions.assumeTrue(holding.isPresent(), "the engine cannot hold a stopped run");
        GuestRuntime held = holding.get();
        try {
            ProgramRunner runner = ProgramRunner.on(held);
            Program program = RuntimeTckAssets.sandboxProgram();
            List<String> argv = RunScript.argv(Program.Kind.SANDBOX);
            Budget budget = new Budget(2, 32L << 20, Budget.STDOUT_LIMIT, Budget.STDERR_LIMIT);
            RunOutput stopped = runner.run(program, "for (;;) {}", argv, new byte[0], budget);
            assertThat(stopped.termination()).isEqualTo(Termination.BUDGET);
            assertThat(held.strayRuns()).isEqualTo(1);
            Throwable refused = catchThrowable(() -> runner.run(program, "print(1);", argv, new byte[0], budget));
            assertThat(refused).isInstanceOf(ProgramUnavailableException.class).hasMessageContaining("stopped runs");
            assertThat(((ProgramUnavailableException) refused).code()).isEqualTo("server.unavailable");
            assertThat(((ProgramUnavailableException) refused).httpStatus()).isEqualTo(503);
            assertThat(refused.getCause()).isInstanceOf(com.argusvane.datum.sandbox.wasi.GuestUnavailableException.class);
        } finally {
            hold.countDown();
            if (held instanceof AutoCloseable closeable) {
                closeable.close();
            }
        }
    }

    /**
     * A check that runs into its own budget after it started is the definition's doing: {@code definition.tooCostly},
     * not 503. The proof that the runtime hands the started marker back.
     */
    @Test
    default void aCheckStoppedAfterItStartedIsTooCostly() {
        SandboxService service = realService(ProgramLimits.builder().validationSeconds(2).build());
        ObjectNode definition = RuntimeTckAssets.JSON.createObjectNode();
        definition.put("id", "costly");
        definition.set("root", context(null).get("form"));
        SandboxException e = catchThrowableOfType(SandboxException.class,
            () -> service.check(definition, List.of("form", "text"), rule("loop", "(function () { for (;;) {} })()")));
        assertThat(e).isNotNull();
        assertThat(e.typedCode()).isEqualTo("definition.tooCostly");
    }

    /**
     * A rule module that allocates without end runs QuickJS out of memory at the limit: the run exits with QuickJS's
     * "out of memory", which datum-core reads as a memory stop the guest ran into; the next run answers.
     */
    @Test
    default void aMemoryBombStopsAtTheLimit() {
        SandboxService service = realService(ProgramLimits.defaults());
        SandboxException e = catchThrowableOfType(SandboxException.class, () -> service.validate(context("Ada"),
            rule("bomb", "(function () { var a = []; for (;;) { a.push(new Array(1e5).fill(1.5)); } })()"), false));
        assertThat(e).isNotNull();
        assertThat(e.reason()).isEqualTo(Reason.MEMORY);
        assertThat(e.guestStopped()).isTrue();

        // Inside a validator the kernel catches it: a normal outcome naming the failed validator.
        SandboxResult caught = service.validate(context("Ada"),
            rule("bomb", "({ validators: [function () { var a = []; for (;;) { a.push(new Array(1e5).fill(1.5)); } }] })"), false);
        assertThat(codes(caught)).contains("validator.failed");
        assertThat(codes(service.validate(context("Ada"), List.of(), false))).isEmpty();
    }

    /** Runaway recursion exhausts the instance's own stack and traps; the next run answers. */
    @Test
    default void deepRecursionTraps() {
        SandboxService service = realService(ProgramLimits.defaults());
        SandboxException e = catchThrowableOfType(SandboxException.class, () -> service.validate(context("Ada"),
            rule("deep", "({ validators: [function () { var f = function (n) { return f(n + 1) + 1; }; return f(0); }] })"), false));
        assertThat(e).isNotNull();
        assertThat(e.reason()).isEqualTo(Reason.TRAP);
        assertThat(codes(service.validate(context("Ada"), List.of(), false))).isEmpty();
    }

    /** The service's own smoke run passes on this runtime. */
    @Test
    default void theSmokeRunPasses() {
        SandboxService.Smoke smoke = realService(ProgramLimits.defaults()).smoke();
        assertThat(smoke.ok()).as(smoke.message()).isTrue();
    }
}
