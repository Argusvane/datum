package com.argusvane.datum.sandbox.tck;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.sandbox.wasi.Budget;
import com.argusvane.datum.sandbox.protocol.Frame;
import com.argusvane.datum.sandbox.protocol.Nonce;
import com.argusvane.datum.sandbox.protocol.Program;
import com.argusvane.datum.sandbox.protocol.ProgramRunner;
import com.argusvane.datum.sandbox.wasi.GuestRuntime;
import com.argusvane.datum.sandbox.protocol.RuleModule;
import com.argusvane.datum.sandbox.protocol.RunClassifier;
import com.argusvane.datum.sandbox.wasi.RunOutput;
import com.argusvane.datum.sandbox.protocol.RunScript;
import com.argusvane.datum.sandbox.wasi.Termination;
import java.io.IOException;
import java.lang.management.ManagementFactory;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;

/**
 * The runtime's own promises ({@code GuestRuntime}'s contract), on the real QuickJS: a private {@code /app} with the
 * program's bytes and run.js only and nothing reachable outside it, every way a run ends reported structurally, and the
 * stdout written before a stop handed back with the "started" marker in it (BUDGET, TRAP, OUTPUT_CAP, INTERRUPTED; a
 * memory stop surfaces as an exit, see {@link #aRunPastItsMemoryEndsByItselfAndKeepsItsOutput}), stops one at a time and
 * many at once, shutdown, and a hundred settled runs that add nothing to the heap or the threads.
 */
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
public interface RuntimeContract extends RuntimeUnderTest {

    /** The guest's arguments for a raw run of a script, with qjs:std and qjs:os available. */
    List<String> RAW = List.of("qjs", "--std", "/app/run.js");

    /** A one-field context the real program accepts. */
    String CONTEXT = "{\"formId\":\"t\",\"form\":{\"id\":\"root\",\"type\":\"form\",\"configuration\":{},"
        + "\"children\":{\"content\":[{\"id\":\"name\",\"type\":\"text\",\"configuration\":{\"label\":\"Name\",\"required\":true}}]}},"
        + "\"values\":{\"name\":\"Ada\"},\"locale\":\"en\"}";

    /**
     * A runtime of its own for a test that closes it (shutdown, a closed runtime); it must be {@link AutoCloseable}, as the
     * harness is. The contract closes it.
     */
    GuestRuntime newRuntime();

    /**
     * What the engine says when the guest's recursion exhausts the instance's stack. The default asks only that the trap
     * says something; an engine pins its own words by overriding this.
     */
    default void checkStackTrapMessage(String trapMessage) {
        assertThat(trapMessage).as("a trap says what trapped").isNotBlank();
    }

    /**
     * The JVM's first runs are slow until the engine's set-up is compiled: paid for here, not in a budget. Three: after
     * two cold runs the third only just reached its first line within 2 s.
     */
    @BeforeAll
    default void warmUpTheEngine() {
        for (int i = 0; i < 3; i++) {
            raw("print(1);", budget(30, 32));
        }
    }

    // ------------------------------------------------------------------------------------------------- helpers

    private static Budget budget(int seconds, int mib) {
        return new Budget(seconds, (long) mib << 20, Budget.STDOUT_LIMIT, Budget.STDERR_LIMIT);
    }

    private RunOutput raw(String script, Budget budget) {
        return runtime().run(ProgramRunner.guestRun(RuntimeTckAssets.sandboxProgram(), script, RAW, new byte[0], budget));
    }

    private static String out(RunOutput output) {
        return new String(output.stdout(), StandardCharsets.UTF_8);
    }

    private static String err(RunOutput output) {
        return new String(output.stderr(), StandardCharsets.UTF_8);
    }

    /** A sandbox run of the real program with these rule modules, as SandboxService makes it. */
    private RunOutput sandbox(String nonce, List<RuleModule> rules, Budget budget) {
        return runtime().run(ProgramRunner.guestRun(RuntimeTckAssets.sandboxProgram(), RuntimeTckAssets.scripts().sandbox(rules, RunScript.Entry.RUN),
            RunScript.argv(Program.Kind.SANDBOX), Nonce.stdin(nonce, CONTEXT), budget));
    }

    private static List<RuleModule> rule(String source) {
        return List.of(new RuleModule("probe", "1", source));
    }

    /** Runs a test against a runtime of its own and closes it however the test ends. */
    private void withOwnRuntime(OwnRuntimeTest test) throws Exception {
        GuestRuntime own = newRuntime();
        assertThat(own).as("a runtime the contract can close").isInstanceOf(AutoCloseable.class);
        try {
            test.run(own);
        } finally {
            ((AutoCloseable) own).close();
        }
    }

    /** A test body over a runtime of its own. */
    @FunctionalInterface
    interface OwnRuntimeTest {
        void run(GuestRuntime runtime) throws Exception;
    }

    private static long usedHeapAfterGc() throws InterruptedException {
        for (int i = 0; i < 3; i++) {
            System.gc();
            Thread.sleep(100);
        }
        return ManagementFactory.getMemoryMXBean().getHeapMemoryUsage().getUsed();
    }

    // ------------------------------------------------------------------------------------------------- the /app

    @Test
    default void aRunSeesOnlyItsProgramAndRunJsAndNoEnvironment() {
        Program program = RuntimeTckAssets.sandboxProgram();
        RunOutput output = raw(String.join("\n",
            // os.stat answers an error for every path on this file system (Endive's path_filestat_get over Jimfs),
            // so a path exists when it opens.
            "var exists = function (path) { var f = std.open(path, 'r'); if (f) { f.close(); return true; } return false; };",
            "print(JSON.stringify([exists('/app/datum-sandbox-program.js'), exists('/app/run.js')]));",
            // Nothing outside the preopen: not the host's files, not the in-memory file system's root.
            "print(JSON.stringify([exists('/etc/passwd'), exists('/app/../etc/passwd'), exists('/'), exists('/app/datum-pdf-program.js'),",
            "  exists('/tmp')]));",
            "print(JSON.stringify(std.getenviron()));",
            "print(JSON.stringify(scriptArgs));",
            "var listed = os.readdir('/app');",
            "print(JSON.stringify(listed[0].filter(function (n) { return n !== '.' && n !== '..'; }).sort()));",
            "print(std.loadFile('/app/datum-sandbox-program.js'));"), budget(30, 64));
        assertThat(output.termination()).isEqualTo(Termination.EXITED);
        assertThat(output.exitCode()).as(err(output)).isZero();
        String text = out(output);
        String[] lines = text.split("\n", 6);
        assertThat(lines[0]).isEqualTo("[true,true]");
        assertThat(lines[1]).as("only the preopen is reachable").isEqualTo("[false,false,false,false,false]");
        assertThat(lines[2]).as("no environment").isEqualTo("{}");
        assertThat(lines[3]).isEqualTo("[\"/app/run.js\"]");
        // Endive's fd_readdir lists nothing on this file system (seen on both runners); a listing, when there is one,
        // must name the two files only.
        assertThat(lines[4]).isIn("[]", "[\"datum-sandbox-program.js\",\"run.js\"]");
        // The guest reads a copy of exactly the bytes that were hashed (and so proved).
        byte[] copy = lines[5].getBytes(StandardCharsets.UTF_8);
        byte[] expected = (new String(program.bytes(), StandardCharsets.UTF_8) + "\n").getBytes(StandardCharsets.UTF_8);
        assertThat(copy.length).isEqualTo(expected.length);
        assertThat(RuntimeTckAssets.sha256(copy)).isEqualTo(RuntimeTckAssets.sha256(expected));
    }

    /**
     * Nothing outside {@code /app} is reachable by any route: dot segments, absolute paths, a symbolic link the guest
     * tries to make, or a module {@code import()}. The proof uses a file on the host's disk that is valid JavaScript and
     * that the guest could import if it could reach it, so a refusal cannot be a parse error in disguise.
     */
    @Test
    default void theGuestReachesNothingOutsideItsDirectory() throws IOException {
        Path hostDir = Files.createTempDirectory("datum-sandbox-tck");
        Path hostModule = hostDir.resolve("host-module.js");
        Files.writeString(hostModule, "export default 'REACHED-THE-HOST';\nprint('REACHED-THE-HOST');\n");
        try {
            String host = hostModule.toAbsolutePath().toString().replace("\\", "/");
            String quoted = RuntimeTckAssets.JSON.writeValueAsString(host);
            String parent = RuntimeTckAssets.JSON.writeValueAsString("/app/.." + host);
            String dots = RuntimeTckAssets.JSON.writeValueAsString("../../../../../../../.." + host);
            String fileUrl = RuntimeTckAssets.JSON.writeValueAsString("file://" + host);
            RunOutput output = raw(String.join("\n",
                "var opens = function (path) { var f = std.open(path, 'r'); if (f) { f.close(); return true; } return false; };",
                "print(JSON.stringify([opens(" + quoted + "), opens(" + parent + "), opens(" + dots + "), std.loadFile(" + quoted + ") !== null,",
                "  opens('../run.js')]));",
                "var linked = typeof os.symlink === 'function' ? os.symlink(" + quoted + ", '/app/link') : -1;",
                "print(JSON.stringify([linked < 0, opens('/app/link'), typeof os.readlink === 'function' ? os.readlink('/app/run.js')[1] !== 0 : true]));",
                "var tried = [" + quoted + ", " + parent + ", " + dots + ", " + fileUrl + ", '/etc/hosts', '../../etc/hosts'];",
                "Promise.allSettled(tried.map(function (p) { return import(p); })).then(function (r) {",
                "  print(JSON.stringify(r.map(function (x) { return x.status; })));",
                "  print(JSON.stringify(r.map(function (x) { return x.status === 'rejected' && /SyntaxError/.test(String(x.reason)); })));",
                "});"), budget(30, 64));
            assertThat(output.termination()).isEqualTo(Termination.EXITED);
            assertThat(output.exitCode()).as(err(output)).isZero();
            String text = out(output);
            assertThat(text).as("the host file's code never ran").doesNotContain("REACHED-THE-HOST");
            String[] lines = text.split("\n");
            assertThat(lines).hasSize(4);
            assertThat(lines[0]).as("the host's absolute path, through /app/.., through dot segments, loadFile, and ../run.js")
                .isEqualTo("[false,false,false,false,false]");
            assertThat(lines[1]).as("no symbolic link can be made, followed or read").isEqualTo("[true,false,true]");
            assertThat(lines[2]).as("import() of any path outside /app is rejected").isEqualTo(
                "[\"rejected\",\"rejected\",\"rejected\",\"rejected\",\"rejected\",\"rejected\"]");
            assertThat(lines[3]).as("rejected because nothing was found, never because something was read and failed to parse")
                .isEqualTo("[false,false,false,false,false,false]");
        } finally {
            Files.deleteIfExists(hostModule);
            Files.deleteIfExists(hostDir);
        }
    }

    /**
     * The guest's /app is read-only: nothing can be created, changed or removed, so neither content nor names (which
     * Jimfs keeps on the heap until the run ends, outside its size cap) can grow the JVM heap. A name bomb,
     * directories with 200,000-character names for as long as the run lasts, creates nothing.
     */
    @Test
    default void theGuestCannotWriteToItsDirectory() {
        RunOutput output = raw(String.join("\n",
            "var r = [];",
            "r.push(std.open('/app/big', 'w') === null);",
            "r.push(std.open('/app/run.js', 'a') === null);",
            "r.push(std.open('/app/run.js', 'r+') === null);",
            "r.push(std.open('/app/run.js', 'w') === null);",
            "r.push(os.mkdir('/app/d') < 0);",
            "r.push(os.remove('/app/run.js') < 0);",
            "r.push(os.rename('/app/run.js', '/app/moved.js') < 0);",
            "r.push(typeof os.symlink !== 'function' || os.symlink('/app/run.js', '/app/link') < 0);",
            "r.push(typeof os.utimes !== 'function' || os.utimes('/app/run.js', 0, 0) < 0);",
            "var w = std.open('/app/run.js', 'r'); w.puts('overwritten'); w.flush(); w.close();",
            "print(JSON.stringify(r));",
            // The monotonic clock (os.now, microseconds): the wall clock the guest reads stands still.
            "var tried = 0, made = 0, until = os.now() + 1500000, long = 'a'.repeat(200000);",
            "while (os.now() < until) { if (os.mkdir('/app/' + long + tried) === 0) { made++; } tried++; }",
            "print(JSON.stringify([tried > 0, made]));",
            "print(std.loadFile('/app/run.js').indexOf('var r = [];') === 0);"), budget(30, 128));
        assertThat(output.termination()).isEqualTo(Termination.EXITED);
        assertThat(output.exitCode()).as(err(output)).isZero();
        String[] lines = out(output).split("\n");
        assertThat(lines[0]).as("open for writing, mkdir, remove, rename, symlink, utimes").isEqualTo("[true,true,true,true,true,true,true,true,true]");
        assertThat(lines[1]).as("the name bomb made nothing").isEqualTo("[true,0]");
        assertThat(lines[2]).as("run.js is untouched").isEqualTo("true");
    }

    // ------------------------------------------------------------------------------------------------- how runs end

    @Test
    default void exitsAndThrowsAreExitsWithTheirCodes() {
        RunOutput ok = raw("print('fine');", budget(30, 32));
        assertThat(ok.termination()).isEqualTo(Termination.EXITED);
        assertThat(ok.exitCode()).isZero();
        assertThat(out(ok)).isEqualTo("fine\n");

        RunOutput exit = raw("print('before'); std.exit(3);", budget(30, 32));
        assertThat(exit.termination()).isEqualTo(Termination.EXITED);
        assertThat(exit.exitCode()).isEqualTo(3);
        assertThat(out(exit)).isEqualTo("before\n");

        RunOutput thrown = raw("print('before'); throw new Error('boom from the guest');", budget(30, 32));
        assertThat(thrown.termination()).isEqualTo(Termination.EXITED);
        assertThat(thrown.exitCode()).isEqualTo(1);
        assertThat(out(thrown)).isEqualTo("before\n");
        assertThat(err(thrown)).contains("boom from the guest");
    }

    @Test
    default void aRunStoppedAtItsBudgetKeepsTheStartedMarkerAndTheNextRunAnswers() {
        String nonce = Nonce.generate();
        long started = System.nanoTime();
        RunOutput output = sandbox(nonce, rule("({ validators: [function () { for (;;) {} }] })"), budget(2, 32));
        double seconds = (System.nanoTime() - started) / 1e9;
        assertThat(output.termination()).isEqualTo(Termination.BUDGET);
        assertThat(Frame.started(output.stdout(), nonce)).as("the started marker reached stdout: " + out(output)).isTrue();
        assertThat(seconds).as("stopped at the budget, not later").isLessThan(2 + stopGrace().toSeconds());

        String next = Nonce.generate();
        RunOutput answered = sandbox(next, List.of(), budget(5, 32));
        assertThat(answered.termination()).isEqualTo(Termination.EXITED);
        String answer = new String(RunClassifier.sandboxAnswer(answered, next, budget(5, 32)), StandardCharsets.UTF_8);
        assertThat(answer).contains("\"errors\":[]").contains("\"name\":\"Ada\"");
    }

    @Test
    default void aTrapKeepsTheStartedMarker() {
        String nonce = Nonce.generate();
        RunOutput output = sandbox(nonce,
            rule("({ validators: [function () { var f = function (n) { return f(n + 1) + 1; }; return f(0); }] })"), budget(30, 32));
        assertThat(output.termination()).isEqualTo(Termination.TRAP);
        checkStackTrapMessage(output.trapMessage());
        assertThat(Frame.started(output.stdout(), nonce)).isTrue();
    }

    @Test
    default void aRunPastAnOutputCapStopsAtOnceAndKeepsWhatFit() {
        RunOutput output = raw("print('@@started@@'); var s = 'x'.repeat(1 << 20); for (var i = 0; i < 40; i++) { print(s); } print('done');",
            budget(30, 128));
        assertThat(output.termination()).isEqualTo(Termination.OUTPUT_CAP);
        assertThat(output.stdoutLength()).isEqualTo((int) Budget.STDOUT_LIMIT);
        assertThat(out(output)).startsWith("@@started@@\n").doesNotContain("done");

        RunOutput stderr = raw("print('@@started@@'); std.err.puts('y'.repeat(100000)); print('done');", budget(30, 32));
        assertThat(stderr.termination()).isEqualTo(Termination.OUTPUT_CAP);
        assertThat(stderr.stderrLength()).isEqualTo((int) Budget.STDERR_LIMIT);
        assertThat(out(stderr)).isEqualTo("@@started@@\n");
    }

    @Test
    default void aHostInterruptStopsTheRunAndKeepsItsOutput() throws Exception {
        String nonce = Nonce.generate();
        AtomicReference<RunOutput> result = new AtomicReference<>();
        AtomicReference<Boolean> flagKept = new AtomicReference<>();
        Thread caller = new Thread(() -> {
            result.set(sandbox(nonce, rule("({ validators: [function () { for (;;) {} }] })"), budget(60, 32)));
            flagKept.set(Thread.currentThread().isInterrupted());
        });
        caller.start();
        Thread.sleep(2500);
        caller.interrupt();
        caller.join(15_000);
        assertThat(caller.isAlive()).isFalse();
        assertThat(result.get().termination()).isEqualTo(Termination.INTERRUPTED);
        assertThat(Frame.started(result.get().stdout(), nonce)).isTrue();
        assertThat(flagKept.get()).as("the caller's interrupt is kept").isTrue();
    }

    @Test
    default void aRunPastItsMemoryEndsByItselfAndKeepsItsOutput() {
        // QuickJS's allocator sees memory.grow fail (-1) and QuickJS reports it: an exit, never a trap.
        // A runtime never reports Termination.MEMORY for it (a full JVM heap is the host's INTERRUPTED); the guest's own
        // memory stop is read from this exit by RunClassifier.
        RunOutput output = raw("print('@@started@@'); var a = []; for (;;) { a.push(new ArrayBuffer(1 << 20)); }", budget(30, 32));
        assertThat(output.termination()).isEqualTo(Termination.EXITED);
        assertThat(output.exitCode()).isEqualTo(1);
        assertThat(err(output)).contains("out of memory");
        assertThat(out(output)).isEqualTo("@@started@@\n");
        assertThat(raw("print('again');", budget(30, 32)).exitCode()).as("the next run is fine").isZero();
    }

    // ------------------------------------------------------------------------------------------------- concurrency

    @Test
    default void runsInParallelKeepTheirOwnStreams() throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(4);
        try {
            List<Future<RunOutput>> futures = new ArrayList<>();
            for (int i = 0; i < 4; i++) {
                String word = "run-" + i;
                futures.add(pool.submit(() -> runtime().run(ProgramRunner.guestRun(RuntimeTckAssets.sandboxProgram(), "print(std.in.readAsString());", RAW,
                    word.getBytes(StandardCharsets.UTF_8), budget(60, 32)))));
            }
            for (int i = 0; i < 4; i++) {
                RunOutput output = futures.get(i).get();
                assertThat(output.exitCode()).isZero();
                assertThat(out(output)).isEqualTo("run-" + i + "\n");
            }
        } finally {
            pool.shutdownNow();
        }
    }

    /**
     * Cancellation under concurrency: eight looping runs stopped at their budgets at once, some before their first line
     * (still in set-up), each reported as a budget stop, none left alive past its grace, and the next run answers.
     */
    @Test
    default void runsStoppedTogetherAllEndAsBudgetStopsAndTheNextRunAnswers() throws Exception {
        int runs = 8;
        ExecutorService pool = Executors.newFixedThreadPool(runs);
        try {
            List<Future<RunOutput>> futures = new ArrayList<>();
            for (int i = 0; i < runs; i++) {
                futures.add(pool.submit(() -> raw("print('@@started@@'); for (;;) {}", budget(2, 64))));
            }
            for (Future<RunOutput> future : futures) {
                RunOutput output = future.get(2 + stopGrace().toSeconds() + 30, TimeUnit.SECONDS);
                assertThat(output.termination()).isEqualTo(Termination.BUDGET);
                assertThat(out(output)).isIn("", "@@started@@\n");
            }
        } finally {
            pool.shutdownNow();
        }
        assertThat(runtime().strayRuns()).as("no stopped run outlived its grace (-1: not counted)").isLessThanOrEqualTo(0);
        assertThat(raw("print('again');", budget(30, 32)).exitCode()).as("the next run is fine").isZero();
    }

    /** Closing the runtime stops every run in flight as INTERRUPTED, and the closed runtime runs nothing. */
    @Test
    default void closingTheRuntimeStopsRunsInFlightAndRunsNothingAfter() throws Exception {
        withOwnRuntime(closing -> {
            ExecutorService pool = Executors.newFixedThreadPool(4);
            try {
                List<Future<RunOutput>> futures = new ArrayList<>();
                for (int i = 0; i < 4; i++) {
                    futures.add(pool.submit(() -> closing.run(ProgramRunner.guestRun(RuntimeTckAssets.sandboxProgram(), "print('@@started@@'); for (;;) {}", RAW,
                        new byte[0], budget(60, 64)))));
                }
                Thread.sleep(1500);
                ((AutoCloseable) closing).close();
                for (Future<RunOutput> future : futures) {
                    assertThat(future.get(30, TimeUnit.SECONDS).termination()).isEqualTo(Termination.INTERRUPTED);
                }
            } finally {
                pool.shutdownNow();
            }
            RunOutput after = closing.run(ProgramRunner.guestRun(RuntimeTckAssets.sandboxProgram(), "print(1);", RAW, new byte[0], budget(5, 32)));
            assertThat(after.termination()).isEqualTo(Termination.INTERRUPTED);
            assertThat(after.stdoutLength()).isZero();
        });
    }

    @Test
    default void aClosedRuntimeRunsNothing() throws Exception {
        withOwnRuntime(closed -> {
            ((AutoCloseable) closed).close();
            RunOutput output = closed.run(ProgramRunner.guestRun(RuntimeTckAssets.sandboxProgram(), "print(1);", RAW, new byte[0], budget(5, 32)));
            assertThat(output.termination()).isEqualTo(Termination.INTERRUPTED);
            assertThat(output.stdoutLength()).isZero();
        });
    }

    // ------------------------------------------------------------------------------------------------- leaks

    /** The heap a hundred settled runs may add, after GC: a JIT and the collector move it by a few MiB, a leak does not stop. */
    long HEAP_SLOPE_BOUND = 4L << 20;

    /**
     * A heap leak the engine is known to have, as a strict expected failure: empty (the default) holds the engine to
     * {@link #HEAP_SLOPE_BOUND}; a reason makes {@link #aHundredSettledRunsAddNothingToTheHeapOrTheThreads} report the
     * measured leak as aborted with that reason while it shows, and fail once it no longer does, so the declaration
     * cannot outlive the defect. Never a wider bound: an engine that leaks says so here.
     */
    default Optional<String> knownHeapLeak() {
        return Optional.empty();
    }

    /**
     * Full validations of the real program keep the heap and the thread count flat: after five warm-up runs and 45 more to
     * settle the JIT and the engine's caches, the next hundred add less than {@link #HEAP_SLOPE_BOUND} to the heap after
     * GC (each run's instance, file system and buffers are freed with it) and leave no thread behind. The slope, not one
     * delta: 0.4 MiB kept per run is 20 MiB over fifty runs, which a single bound sized for noise lets through, and it
     * runs a host out of heap after some thousands of validations (measured on Endive's JFFI runner).
     */
    @Test
    default void aHundredSettledRunsAddNothingToTheHeapOrTheThreads() throws Exception {
        for (int i = 0; i < 5; i++) {
            assertThat(sandbox(Nonce.generate(), List.of(), budget(30, 32)).termination()).isEqualTo(Termination.EXITED);
        }
        long start = usedHeapAfterGc();
        int threadsBefore = Thread.activeCount();
        validations(45);
        long settled = usedHeapAfterGc();
        validations(100);
        long after = usedHeapAfterGc();
        int threadsAfter = Thread.activeCount();
        long slope = after - settled;
        System.out.printf("[datum-sandbox-tck] runs on %s (%s): heap after GC %d MiB, %d MiB after 50 runs, %d MiB after 150 "
            + "(%+.2f MiB per run over the last 100), threads %d -> %d%n", runtime().engineInfo().id(), runtime().engineInfo().mode(),
            start >> 20, settled >> 20, after >> 20, slope / 100.0 / (1 << 20), threadsBefore, threadsAfter);
        assertThat(threadsAfter - threadsBefore).as("threads left behind by 150 sequential runs").isLessThanOrEqualTo(4);
        assertThat(runtime().strayRuns()).isLessThanOrEqualTo(0);
        Optional<String> known = knownHeapLeak();
        if (known.isEmpty()) {
            assertThat(slope).as("heap added by 100 settled runs, after GC").isLessThan(HEAP_SLOPE_BOUND);
            return;
        }
        assertThat(slope).as("the known heap leak (" + known.get() + ") no longer shows: remove knownHeapLeak()")
            .isGreaterThanOrEqualTo(HEAP_SLOPE_BOUND);
        Assumptions.abort("Known heap leak on " + runtime().engineInfo().id() + " (" + runtime().engineInfo().mode() + "): "
            + (slope >> 20) + " MiB over 100 settled runs, bound " + (HEAP_SLOPE_BOUND >> 20) + " MiB. " + known.get());
    }

    private void validations(int count) {
        for (int i = 0; i < count; i++) {
            String nonce = Nonce.generate();
            RunOutput output = sandbox(nonce, List.of(), budget(30, 32));
            assertThat(output.termination()).as("run " + i).isEqualTo(Termination.EXITED);
            assertThat(new String(RunClassifier.sandboxAnswer(output, nonce, budget(30, 32)), StandardCharsets.UTF_8)).contains("\"errors\":[]");
        }
    }
}
