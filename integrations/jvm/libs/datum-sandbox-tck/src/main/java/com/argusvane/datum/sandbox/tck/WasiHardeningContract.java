package com.argusvane.datum.sandbox.tck;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.catchThrowable;

import com.argusvane.datum.sandbox.wasi.Budget;
import com.argusvane.datum.sandbox.wasi.EngineConfigurationException;
import com.argusvane.datum.sandbox.wasi.EngineLimits;
import com.argusvane.datum.sandbox.wasi.EngineSettings;
import com.argusvane.datum.sandbox.wasi.GuestRun;
import com.argusvane.datum.sandbox.wasi.GuestRuntime;
import com.argusvane.datum.sandbox.wasi.GuestRuntimeProvider;
import com.argusvane.datum.sandbox.wasi.GuestUnavailableException;
import com.argusvane.datum.sandbox.wasi.MemoryFloorException;
import com.argusvane.datum.sandbox.wasi.RunOutput;
import com.argusvane.datum.sandbox.wasi.Termination;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CountDownLatch;
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
 * The hardened WASI run on a real engine, through {@link GuestRuntime} and {@link GuestRun} alone: no Datum program, no protocol, only a tiny inline {@code run.js} and whatever files a run is handed.
 * What every engine owes the layer above, whatever it runs:
 * <ul>
 *   <li>a fresh, read-only, in-memory {@code /app} per run holding exactly the run's files, as the only preopen;</li>
 *   <li>no host environment, no network, no process, stdin and argv as given;</li>
 *   <li>the budget's time and memory limits, enforced by the engine;</li>
 *   <li>output caps that stop the run at once, even when the guest catches the write (never an {@code EIO} it can
 *       ignore);</li>
 *   <li>every byte written before any ending handed back (an exit, a throw, the time budget, a cap, a host interrupt);</li>
 *   <li>runs stopped together, some still in set-up, all ending as budget stops, with no stray left and the next run
 *       answering (an engine that let a stop interrupt its set-up would leak or fail here);</li>
 *   <li>every instance closed however {@code _start} ended, when the engine counts its open instances
 *       ({@link #openInstances});</li>
 *   <li>the stray-run bound, when the engine can hold a stopped run ({@link #holdingRuntime});</li>
 *   <li>a closed runtime running nothing, and stopping the runs in flight as host interruptions;</li>
 *   <li>a budget the engine cannot honour refused before the run, and a least memory budget below the module's own
 *       refused at creation ({@link #provider});</li>
 *   <li>a script the guest cannot find answered as the runtime's failure before the guest's first line: a
 *       {@link GuestUnavailableException}, or exit 127 or "No such file" with nothing on stdout.</li>
 * </ul>
 * The JVM out of heap (read as the host's interruption) needs a JVM with a small heap and an engine whose linear memory is
 * on it; datum-sandbox's {@code RunHarnessTest} and the engine's own bytecode-fallback execution hold it.
 */
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
public interface WasiHardeningContract extends RuntimeUnderTest {

    /** The guest's arguments for a run of {@code /app/run.js}, with qjs:std and qjs:os available. */
    List<String> ARGV = List.of("qjs", "--std", "/app/run.js");

    /**
     * A runtime of its own for a test that closes it; it must be {@link AutoCloseable}, as the harness is. The contract closes
     * it.
     */
    GuestRuntime newRuntime();

    /** The engine's provider, for the floor at creation; empty skips that test. */
    default Optional<GuestRuntimeProvider> provider() {
        return Optional.empty();
    }

    /** Instances of {@code runtime} built and not yet closed, or -1 when the engine does not count them. */
    default long openInstances(GuestRuntime runtime) {
        return -1;
    }

    /** The first runs pay for the engine's set-up to be compiled, not a budget. */
    @BeforeAll
    default void warmUpTheWasiEngine() {
        for (int i = 0; i < 3; i++) {
            run(script("print(1);"), budget(30, 32));
        }
    }

    // ------------------------------------------------------------------------------------------------- helpers

    private static Budget budget(int seconds, int mib) {
        return new Budget(seconds, (long) mib << 20, Budget.STDOUT_LIMIT, Budget.STDERR_LIMIT);
    }

    private static byte[] utf8(String text) {
        return text.getBytes(StandardCharsets.UTF_8);
    }

    /** The files of a run: run.js with these lines, then name and content pairs. */
    private static Map<String, byte[]> files(String script, String... more) {
        Map<String, byte[]> files = new LinkedHashMap<>();
        files.put("run.js", utf8(script));
        for (int i = 0; i < more.length; i += 2) {
            files.put(more[i], utf8(more[i + 1]));
        }
        return files;
    }

    private static Map<String, byte[]> script(String... lines) {
        return files(String.join("\n", lines) + "\n");
    }

    private RunOutput run(Map<String, byte[]> files, Budget budget) {
        return runtime().run(GuestRun.of(files, ARGV, new byte[0], budget));
    }

    private static String out(RunOutput output) {
        return new String(output.stdout(), StandardCharsets.UTF_8);
    }

    private static String err(RunOutput output) {
        return new String(output.stderr(), StandardCharsets.UTF_8);
    }

    /** A guest helper: whether a path opens for reading. */
    String OPENS = "var opens = function (path) { var f = std.open(path, 'r'); if (f) { f.close(); return true; } return false; };";

    /** Runs a test against a runtime of its own and closes it however the test ends. */
    private static void closing(GuestRuntime own, OwnRuntimeTest test) throws Exception {
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

    // ------------------------------------------------------------------------------------------------- the /app

    @Test
    default void theAppHoldsExactlyTheRunsFilesReadOnlyAsTheOnlyPreopen() {
        RunOutput output = run(files(String.join("\n", OPENS,
            "print(JSON.stringify([opens('/app/run.js'), opens('/app/data.txt'), opens('/app/empty.txt')]));",
            "print(std.loadFile('/app/data.txt'));",
            "print(JSON.stringify(std.loadFile('/app/empty.txt')));",
            "print(JSON.stringify([opens('/etc/passwd'), opens('/app/../etc/passwd'), opens('/'), opens('/tmp'), opens('/app/missing.txt'),",
            "  opens('../run.js')]));",
            "var w = [];",
            "w.push(std.open('/app/new.txt', 'w') === null);",
            "w.push(std.open('/app/data.txt', 'a') === null);",
            "w.push(std.open('/app/data.txt', 'r+') === null);",
            "w.push(os.mkdir('/app/d') < 0);",
            "w.push(os.remove('/app/data.txt') < 0);",
            "w.push(os.rename('/app/data.txt', '/app/moved.txt') < 0);",
            "w.push(typeof os.symlink !== 'function' || os.symlink('/app/data.txt', '/app/link') < 0);",
            "print(JSON.stringify(w));",
            "print(std.loadFile('/app/data.txt'));") + "\n", "data.txt", "payload ü ☃", "empty.txt", ""), budget(30, 64));
        assertThat(output.termination()).isEqualTo(Termination.EXITED);
        assertThat(output.exitCode()).as(err(output)).isZero();
        String[] lines = out(output).split("\n");
        assertThat(lines[0]).as("the run's files are there").isEqualTo("[true,true,true]");
        assertThat(lines[1]).as("byte for byte").isEqualTo("payload ü ☃");
        assertThat(lines[2]).as("an empty file is a file").isEqualTo("\"\"");
        assertThat(lines[3]).as("nothing outside the preopen, nothing not handed over").isEqualTo("[false,false,false,false,false,false]");
        assertThat(lines[4]).as("open for writing, mkdir, remove, rename, symlink").isEqualTo("[true,true,true,true,true,true,true]");
        assertThat(lines[5]).as("the file is untouched").isEqualTo("payload ü ☃");
    }

    @Test
    default void eachRunGetsAFreshAppAndNothingOfTheRunBefore() {
        RunOutput first = run(files(String.join("\n", OPENS, "print(opens('/app/first.txt'));", "print(std.open('/app/left.txt', 'w') === null);")
            + "\n", "first.txt", "1"), budget(30, 32));
        assertThat(out(first)).as(err(first)).isEqualTo("true\ntrue\n");
        RunOutput second = run(files(String.join("\n", OPENS,
            "print(JSON.stringify([opens('/app/first.txt'), opens('/app/left.txt'), opens('/app/second.txt')]));") + "\n", "second.txt", "2"),
            budget(30, 32));
        assertThat(out(second)).as(err(second)).isEqualTo("[false,false,true]\n");
    }

    @Test
    default void runsInParallelKeepTheirOwnFilesStdinAndStreams() throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(4);
        try {
            List<Future<RunOutput>> futures = new ArrayList<>();
            for (int i = 0; i < 4; i++) {
                String word = "run-" + i;
                futures.add(pool.submit(() -> runtime().run(GuestRun.of(files("print(std.loadFile('/app/own.txt') + '|' + std.in.readAsString());\n",
                    "own.txt", word), ARGV, utf8(word + "-stdin"), budget(60, 32)))));
            }
            for (int i = 0; i < 4; i++) {
                RunOutput output = futures.get(i).get();
                assertThat(output.exitCode()).as(err(output)).isZero();
                assertThat(out(output)).isEqualTo("run-" + i + "|run-" + i + "-stdin\n");
            }
        } finally {
            pool.shutdownNow();
        }
    }

    // ------------------------------------------------------------------------------------------------- what the guest gets

    @Test
    default void noEnvironmentNoNetworkNoProcessAndStdinAndArgvAsGiven() {
        String stdin = "line one\n{\"é\":\"☃\"}";
        RunOutput output = runtime().run(GuestRun.of(files(String.join("\n",
            "var tried = function (f) { try { var r = f(); return r === null || r === undefined || r < 0; } catch (e) { return true; } };",
            "print(JSON.stringify(std.getenviron()));",
            "print(JSON.stringify([std.getenv('PATH') === undefined, std.getenv('HOME') === undefined]));",
            "print(JSON.stringify([typeof std.urlGet !== 'function' || tried(function () { return std.urlGet('http://127.0.0.1:9/'); }),",
            "  typeof std.popen !== 'function' || tried(function () { return std.popen('echo REACHED', 'r'); }),",
            "  typeof os.exec !== 'function' || tried(function () { return os.exec(['/bin/echo', 'REACHED']); })]));",
            "print(JSON.stringify(scriptArgs));",
            "print(std.in.readAsString());") + "\n"), List.of("qjs", "--std", "/app/run.js", "one", "two"), utf8(stdin), budget(30, 32)));
        assertThat(output.termination()).isEqualTo(Termination.EXITED);
        assertThat(output.exitCode()).as(err(output)).isZero();
        String text = out(output);
        assertThat(text).doesNotContain("REACHED");
        String[] lines = text.split("\n", 5);
        assertThat(lines[0]).as("no host environment").isEqualTo("{}");
        assertThat(lines[1]).isEqualTo("[true,true]");
        assertThat(lines[2]).as("no network, no process").isEqualTo("[true,true,true]");
        assertThat(lines[3]).as("the arguments as given").isEqualTo("[\"/app/run.js\",\"one\",\"two\"]");
        assertThat(lines[4]).as("stdin as given, byte for byte").isEqualTo(stdin + "\n");
    }

    // ------------------------------------------------------------------------------------------------- the budget

    @Test
    default void theTimeBudgetStopsTheRunKeepsWhatItWroteAndTheNextRunAnswers() {
        long started = System.nanoTime();
        RunOutput output = run(script("print('@@started@@');", "for (;;) {}"), budget(2, 32));
        double seconds = (System.nanoTime() - started) / 1e9;
        assertThat(output.termination()).isEqualTo(Termination.BUDGET);
        assertThat(out(output)).as("what was written before the stop").isEqualTo("@@started@@\n");
        assertThat(seconds).as("stopped at the budget, not later").isLessThan(2 + stopGrace().toSeconds());
        assertThat(run(script("print('again');"), budget(30, 32)).exitCode()).as("the next run is fine").isZero();
    }

    /** The memory limit is the engine's own: the same guest finishes in a larger budget and cannot in a smaller one. */
    @Test
    default void theMemoryBudgetIsTheEnginesOwnLimit() {
        Map<String, byte[]> grows = script("print('@@started@@');", "var a = [];", "for (var i = 0; i < 48; i++) { a.push(new ArrayBuffer(1 << 20)); }",
            "print('done');");
        RunOutput small = run(grows, budget(30, 32));
        assertThat(out(small)).as("the guest could not take 48 MiB in a 32 MiB budget").startsWith("@@started@@\n").doesNotContain("done");
        assertThat(small.termination()).as("it ended by itself, not at the time budget").isNotEqualTo(Termination.BUDGET);
        assertThat(small.termination() == Termination.EXITED ? small.exitCode() : -1).as("never a clean exit").isNotZero();
        RunOutput large = run(grows, budget(30, 128));
        assertThat(large.exitCode()).as(err(large)).isZero();
        assertThat(out(large)).isEqualTo("@@started@@\ndone\n");
    }

    @Test
    default void aBudgetTheEngineCannotHonourIsRefusedBeforeTheRun() {
        Throwable refused = catchThrowable(() -> run(script("print(1);"), new Budget(5, 1, Budget.STDOUT_LIMIT, Budget.STDERR_LIMIT)));
        assertThat(refused).as("a one-byte memory budget").isInstanceOf(IllegalArgumentException.class);
        assertThat(run(script("print('again');"), budget(30, 32)).exitCode()).isZero();
    }

    // ------------------------------------------------------------------------------------------------- the caps

    /** The write past a cap ends the run at once: a guest that catches the failed write does not carry on. */
    @Test
    default void anOutputCapStopsTheRunAtOnceEvenWhenTheGuestCatchesTheWrite() {
        Budget small = new Budget(30, 32L << 20, 4096, 1024);
        RunOutput stdout = run(script("print('@@started@@');", "try { for (var i = 0; i < 100; i++) { std.out.puts('x'.repeat(1000)); std.out.flush(); } }",
            "catch (e) { }", "print('after');", "std.out.flush();", "std.err.puts('carried on');"), small);
        assertThat(stdout.termination()).isEqualTo(Termination.OUTPUT_CAP);
        assertThat(stdout.stdoutLength()).as("exactly the cap is kept").isEqualTo(4096);
        assertThat(out(stdout)).startsWith("@@started@@\n").doesNotContain("after");
        assertThat(err(stdout)).doesNotContain("carried on");

        RunOutput stderr = run(script("print('@@started@@');", "std.out.flush();", "try { std.err.puts('y'.repeat(5000)); } catch (e) { }",
            "print('after');", "std.out.flush();"), small);
        assertThat(stderr.termination()).isEqualTo(Termination.OUTPUT_CAP);
        assertThat(stderr.stderrLength()).isEqualTo(1024);
        assertThat(out(stderr)).isEqualTo("@@started@@\n");
        assertThat(run(script("print('again');"), budget(30, 32)).exitCode()).as("the next run is fine").isZero();
    }

    // ------------------------------------------------------------------------------------------------- how runs end

    @Test
    default void everyEndingHandsBackWhatWasWritten() {
        RunOutput ok = run(script("print('fine');"), budget(30, 32));
        assertThat(ok.termination()).isEqualTo(Termination.EXITED);
        assertThat(ok.exitCode()).isZero();
        assertThat(out(ok)).isEqualTo("fine\n");

        RunOutput exit = run(script("print('before');", "std.err.puts('on stderr');", "std.exit(3);"), budget(30, 32));
        assertThat(exit.termination()).isEqualTo(Termination.EXITED);
        assertThat(exit.exitCode()).isEqualTo(3);
        assertThat(out(exit)).isEqualTo("before\n");
        assertThat(err(exit)).contains("on stderr");

        RunOutput thrown = run(script("print('before');", "throw new Error('boom from the guest');"), budget(30, 32));
        assertThat(thrown.termination()).isEqualTo(Termination.EXITED);
        assertThat(thrown.exitCode()).isEqualTo(1);
        assertThat(out(thrown)).isEqualTo("before\n");
        assertThat(err(thrown)).contains("boom from the guest");
    }

    @Test
    default void aHostInterruptStopsTheRunKeepsItsOutputAndTheCallersFlag() throws Exception {
        AtomicReference<RunOutput> result = new AtomicReference<>();
        AtomicReference<Boolean> flagKept = new AtomicReference<>();
        Thread caller = new Thread(() -> {
            result.set(run(script("print('@@started@@');", "for (;;) {}"), budget(60, 32)));
            flagKept.set(Thread.currentThread().isInterrupted());
        });
        caller.start();
        Thread.sleep(2500);
        caller.interrupt();
        caller.join(15_000);
        assertThat(caller.isAlive()).isFalse();
        assertThat(result.get().termination()).isEqualTo(Termination.INTERRUPTED);
        assertThat(out(result.get())).isEqualTo("@@started@@\n");
        assertThat(flagKept.get()).as("the caller's interrupt is kept").isTrue();
    }

    /**
     * Eight looping runs stopped at a one-second budget at once, some still in set-up: each is a budget stop with what it
     * wrote, none outlives its grace, every instance is closed, and the next run answers. Only {@code _start} may be
     * interrupted: an engine whose set-up an interrupt could cut short fails or leaks here.
     */
    @Test
    default void runsStoppedTogetherDuringSetUpAndStartAllEndAsBudgetStops() throws Exception {
        int runs = 8;
        ExecutorService pool = Executors.newFixedThreadPool(runs);
        try {
            List<Future<RunOutput>> futures = new ArrayList<>();
            for (int i = 0; i < runs; i++) {
                futures.add(pool.submit(() -> run(script("print('@@started@@');", "for (;;) {}"), budget(1, 256))));
            }
            for (Future<RunOutput> future : futures) {
                RunOutput output = future.get(1 + stopGrace().toSeconds() + 30, TimeUnit.SECONDS);
                assertThat(output.termination()).isEqualTo(Termination.BUDGET);
                assertThat(out(output)).isIn("", "@@started@@\n");
            }
        } finally {
            pool.shutdownNow();
        }
        assertThat(runtime().strayRuns()).as("no stopped run outlived its grace (-1: not counted)").isLessThanOrEqualTo(0);
        long open = openInstances(runtime());
        assertThat(open).as("every instance closed (-1: not counted)").isLessThanOrEqualTo(0);
        assertThat(run(script("print('again');"), budget(30, 32)).exitCode()).as("the next run is fine").isZero();
    }

    /** However {@code _start} ended, the instance is closed (the engine's count of open instances is back at zero). */
    @Test
    default void theInstanceIsClosedHoweverStartEnded() throws Exception {
        Assumptions.assumeTrue(openInstances(runtime()) >= 0, "the engine does not count its open instances");
        List<Map<String, byte[]>> endings = List.of(script("print(1);"), script("std.exit(3);"), script("throw new Error('x');"),
            script("print('@@started@@');", "for (;;) {}"), script("for (;;) { print('x'.repeat(1 << 20)); }"));
        for (Map<String, byte[]> ending : endings) {
            RunOutput output = run(ending, new Budget(2, 64L << 20, 1 << 20, Budget.STDERR_LIMIT));
            assertThat(openInstances(runtime())).as("after a run that ended " + output.termination()).isZero();
        }
        AtomicReference<RunOutput> interrupted = new AtomicReference<>();
        Thread caller = new Thread(() -> interrupted.set(run(script("for (;;) {}"), budget(60, 32))));
        caller.start();
        Thread.sleep(2000);
        caller.interrupt();
        caller.join(15_000);
        assertThat(interrupted.get().termination()).isEqualTo(Termination.INTERRUPTED);
        assertThat(openInstances(runtime())).as("after a host interrupt").isZero();
    }

    // ------------------------------------------------------------------------------------------------- the runtime

    @Test
    default void closingTheRuntimeStopsRunsInFlightAndRunsNothingAfter() throws Exception {
        closing(newRuntime(), own -> {
            ExecutorService pool = Executors.newFixedThreadPool(4);
            try {
                List<Future<RunOutput>> futures = new ArrayList<>();
                for (int i = 0; i < 4; i++) {
                    futures.add(pool.submit(() -> own.run(GuestRun.of(script("print('@@started@@');", "for (;;) {}"), ARGV, new byte[0],
                        budget(60, 64)))));
                }
                Thread.sleep(1500);
                ((AutoCloseable) own).close();
                for (Future<RunOutput> future : futures) {
                    RunOutput output = future.get(30, TimeUnit.SECONDS);
                    assertThat(output.termination()).isEqualTo(Termination.INTERRUPTED);
                    assertThat(out(output)).isIn("", "@@started@@\n");
                }
            } finally {
                pool.shutdownNow();
            }
            RunOutput after = own.run(GuestRun.of(script("print(1);"), ARGV, new byte[0], budget(5, 32)));
            assertThat(after.termination()).isEqualTo(Termination.INTERRUPTED);
            assertThat(after.stdoutLength()).isZero();
        });
    }

    /**
     * A stopped run whose thread outlives the grace no longer holds its caller's slot, so the runtime counts it and, at its
     * bound, refuses new runs as unavailable until it ends.
     */
    @Test
    default void theStrayBoundRefusesNewRunsUntilTheStoppedRunsEnd() throws Exception {
        CountDownLatch hold = new CountDownLatch(1);
        Optional<GuestRuntime> holding = holdingRuntime(Duration.ofMillis(200), 1, hold);
        Assumptions.assumeTrue(holding.isPresent(), "the engine cannot hold a stopped run");
        try {
            closing(holding.get(), strict -> {
                RunOutput stopped = strict.run(GuestRun.of(script("print('@@started@@');", "for (;;) {}"), ARGV, new byte[0], budget(5, 32)));
                assertThat(stopped.termination()).isEqualTo(Termination.BUDGET);
                assertThat(out(stopped)).isEqualTo("@@started@@\n");
                assertThat(strict.strayRuns()).isEqualTo(1);
                assertThatThrownBy(() -> strict.run(GuestRun.of(script("print(1);"), ARGV, new byte[0], budget(30, 32))))
                    .isInstanceOf(GuestUnavailableException.class).hasMessageContaining("stopped runs");
                hold.countDown();
                long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
                while (strict.strayRuns() > 0 && System.nanoTime() < deadline) {
                    Thread.sleep(20);
                }
                assertThat(strict.strayRuns()).isZero();
                assertThat(strict.run(GuestRun.of(script("print(1);"), ARGV, new byte[0], budget(30, 32))).exitCode()).isZero();
            });
        } finally {
            hold.countDown();
        }
    }

    @Test
    default void aLeastMemoryBudgetBelowTheModulesOwnIsRefusedAtCreation() throws Exception {
        Optional<GuestRuntimeProvider> provider = provider();
        Assumptions.assumeTrue(provider.isPresent(), "no provider under test");
        Throwable refused = catchThrowable(() -> provider.get().create(new EngineLimits(1, 1L << 30), EngineSettings.defaults()));
        assertThat(refused).isInstanceOf(EngineConfigurationException.class).isInstanceOf(MemoryFloorException.class);
        MemoryFloorException floor = (MemoryFloorException) refused;
        assertThat(floor.bytes()).isEqualTo(1);
        assertThat(floor.least()).isGreaterThan(1);
        GuestRuntime made = provider.get().create(new EngineLimits(floor.least(), floor.least()), EngineSettings.defaults());
        try {
            assertThat(made.engineInfo().id()).isEqualTo(provider.get().id());
        } finally {
            if (made instanceof AutoCloseable closeable) {
                closeable.close();
            }
        }
    }

    /** A guest the engine cannot start (its script is not under /app) is the runtime's failure before its first line. */
    @Test
    default void aScriptTheGuestCannotFindIsTheRuntimesFailureBeforeItsFirstLine() {
        Throwable failure = catchThrowable(() -> {
            RunOutput output = runtime().run(GuestRun.of(script("print('never');"), List.of("qjs", "--std", "/app/missing.js"), new byte[0],
                budget(30, 32)));
            assertThat(output.stdoutLength()).as("nothing ran").isZero();
            assertThat(output.termination()).isEqualTo(Termination.EXITED);
            assertThat(output.exitCode() == 127 || err(output).contains("No such file")).as("exit 127 or \"No such file\": " + err(output)
                + " (exit " + output.exitCode() + ")").isTrue();
        });
        assertThat(failure).as("an answer as above, or the layer's own refusal").satisfiesAnyOf(
            nothing -> assertThat(nothing).isNull(),
            refusal -> assertThat(refusal).isInstanceOf(GuestUnavailableException.class));
    }

    @Test
    default void theEngineReportsItsModeInOneSpelling() {
        String mode = runtime().engineInfo().mode();
        assertThat(runtime().engineInfo().id()).isNotBlank();
        assertThat(mode).isNotBlank().isEqualTo(mode.trim().toLowerCase(java.util.Locale.ROOT));
        assertThat(runtime().engineInfo().isBytecode()).isEqualTo("bytecode".equals(mode));
    }
}
