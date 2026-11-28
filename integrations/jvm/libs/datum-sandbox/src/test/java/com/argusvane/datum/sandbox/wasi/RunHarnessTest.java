package com.argusvane.datum.sandbox.wasi;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AccessDeniedException;
import java.nio.file.FileSystem;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.stream.Stream;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/**
 * The engine-neutral half of a run, over {@link ScriptedEngine}: what every engine gets for free and may not
 * change. The same promises on the real QuickJS are datum-sandbox-tck's {@code RuntimeContract}, run by each engine.
 */
class RunHarnessTest {

    /** A program and a run.js, as the protocol above puts them in /app; to the harness they are two files. */
    private static final String PROGRAM_FILE = "datum-sandbox-program.js";
    private static final byte[] PROGRAM = "globalThis.x = 1;".getBytes(StandardCharsets.UTF_8);
    private static final List<String> ARGV = List.of("qjs", "--std", "/app/run.js");

    private final ScriptedEngine engine = new ScriptedEngine();
    private final List<RunHarness> harnesses = new ArrayList<>();

    @AfterEach
    void close() {
        harnesses.forEach(RunHarness::close);
    }

    private RunHarness harness() {
        return harness(EngineSettings.defaults());
    }

    private RunHarness harness(EngineSettings settings) {
        RunHarness harness = new RunHarness(engine, settings);
        harnesses.add(harness);
        return harness;
    }

    private static Budget budget(int seconds) {
        return new Budget(seconds, 32L << 20, Budget.STDOUT_LIMIT, Budget.STDERR_LIMIT);
    }

    private static Map<String, byte[]> files(String programFile, byte[] program, String runScript) {
        Map<String, byte[]> files = new LinkedHashMap<>();
        files.put(programFile, program);
        files.put("run.js", runScript.getBytes(StandardCharsets.UTF_8));
        return files;
    }

    private static GuestRun guestRun(Budget budget) {
        return GuestRun.of(files(PROGRAM_FILE, PROGRAM, "print(1);"), ARGV, "stdin text".getBytes(StandardCharsets.UTF_8), budget);
    }

    private static RunOutput run(RunHarness harness, Budget budget) {
        return harness.run(guestRun(budget));
    }

    private static String out(RunOutput output) {
        return new String(output.stdout(), StandardCharsets.UTF_8);
    }

    private static void write(GuestIo io, String text) throws IOException {
        io.stdout().write(text.getBytes(StandardCharsets.UTF_8));
    }

    @Test
    void aRunGetsItsArgumentsItsStdinAndAReadOnlyAppHoldingOnlyItsTwoFiles() {
        AtomicReference<List<String>> names = new AtomicReference<>();
        AtomicBoolean writeRefused = new AtomicBoolean();
        engine.start = io -> {
            try (Stream<Path> listed = Files.list(io.app())) {
                names.set(listed.map(path -> path.getFileName().toString()).sorted().toList());
            }
            try {
                Files.write(io.app().resolve("big"), new byte[1]);
            } catch (AccessDeniedException e) {
                writeRefused.set(true);
            }
            write(io, new String(Files.readAllBytes(io.app().resolve(PROGRAM_FILE)), StandardCharsets.UTF_8) + "|"
                + Files.readString(io.app().resolve("run.js")) + "|" + new String(io.stdin().readAllBytes(), StandardCharsets.UTF_8)
                + "|" + io.argv());
        };
        RunOutput output = run(harness(), budget(30));
        assertThat(output.termination()).isEqualTo(Termination.EXITED);
        assertThat(output.exitCode()).isZero();
        assertThat(out(output)).isEqualTo("globalThis.x = 1;|print(1);|stdin text|[qjs, --std, /app/run.js]");
        assertThat(names.get()).containsExactly("datum-sandbox-program.js", "run.js");
        assertThat(writeRefused).as("the guest's /app is read-only").isTrue();
        assertThat(engine.lastIo.app().toString()).isEqualTo("/app");
        assertThat(engine.lastIo.app().getFileSystem().isOpen()).as("the run's file system is closed when the run is answered").isFalse();
        assertThat(engine.preparedClosed).as("the engine's WASI layer is closed by the caller").hasValue(1);
        assertThat(engine.instancesClosed).hasValue(1);
    }

    /**
     * Every run reads the same realtime clock, the same file times and the same random_get bytes, a fresh stream each: a
     * guest learns neither the date nor real entropy, and one run's draws do not move the next run's.
     */
    @Test
    void everyRunReadsTheSameClockFileTimesAndRandomBytes() {
        engine.start = io -> {
            byte[] drawn = new byte[32];
            io.random().nextBytes(drawn);
            java.nio.file.attribute.BasicFileAttributes times = Files.readAttributes(io.app().resolve("run.js"),
                java.nio.file.attribute.BasicFileAttributes.class);
            write(io, io.clock().instant() + "|" + io.clock().millis() + "|" + times.lastModifiedTime() + "|" + times.creationTime()
                + "|" + times.lastAccessTime() + "|" + Files.getLastModifiedTime(io.app()) + "|" + java.util.HexFormat.of().formatHex(drawn));
        };
        RunHarness harness = harness();
        String first = out(run(harness, budget(30)));
        assertThat(first).startsWith("1970-01-01T00:00:00Z|0|1970-01-01T00:00:00Z|1970-01-01T00:00:00Z|1970-01-01T00:00:00Z|1970-01-01T00:00:00Z|");
        byte[] expected = new byte[32];
        new java.util.Random(GuestIo.GUEST_SEED).nextBytes(expected);
        assertThat(first).endsWith("|" + java.util.HexFormat.of().formatHex(expected));
        for (int i = 0; i < 3; i++) {
            assertThat(out(run(harness, budget(30)))).as("run %d", i + 2).isEqualTo(first);
        }
        assertThat(out(run(harness(), budget(30)))).as("another harness").isEqualTo(first);
    }

    @Test
    void theWorkspaceHoldsTheTwoFilesAndLittleMore() throws IOException {
        try (FileSystem fs = RunHarness.workspace(guestRun(budget(30)))) {
            Path app = fs.getPath("/app");
            assertThat(Files.readAllBytes(app.resolve("datum-sandbox-program.js"))).isEqualTo(PROGRAM);
            // The store is capped at the two files plus a block each: even past the read-only view, content cannot grow.
            assertThatThrownBy(() -> Files.write(app.resolve("fill"), new byte[64 * 1024])).isInstanceOf(IOException.class);
        }
    }

    /**
     * Each run gets a fresh /app holding exactly its own files, in any number, and nothing of a run before it: the harness
     * knows no program, only the files it is handed.
     */
    @Test
    void eachRunGetsAFreshAppHoldingExactlyItsOwnFiles() {
        AtomicReference<List<String>> names = new AtomicReference<>();
        engine.start = io -> {
            try (Stream<Path> listed = Files.list(io.app())) {
                names.set(listed.map(path -> path.getFileName().toString()).sorted().toList());
            }
            write(io, Files.readString(io.app().resolve("data.txt")));
        };
        RunHarness harness = harness();
        Map<String, byte[]> first = new LinkedHashMap<>();
        first.put("run.js", "print(1);".getBytes(StandardCharsets.UTF_8));
        first.put("data.txt", "first".getBytes(StandardCharsets.UTF_8));
        first.put("empty.bin", new byte[0]);
        RunOutput one = harness.run(GuestRun.of(first, ARGV, new byte[0], budget(30)));
        assertThat(out(one)).isEqualTo("first");
        assertThat(names.get()).containsExactly("data.txt", "empty.bin", "run.js");
        Map<String, byte[]> second = new LinkedHashMap<>();
        second.put("data.txt", "second".getBytes(StandardCharsets.UTF_8));
        RunOutput two = harness.run(GuestRun.of(second, ARGV, new byte[0], budget(30)));
        assertThat(out(two)).isEqualTo("second");
        assertThat(names.get()).as("nothing of the run before").containsExactly("data.txt");
    }

    @Test
    void theWorkspaceOfManyFilesIsCappedAtWhatTheyTake() throws IOException {
        Map<String, byte[]> files = new LinkedHashMap<>();
        for (int i = 0; i < 5; i++) {
            files.put("f" + i + ".js", new byte[10_000]);
        }
        try (FileSystem fs = RunHarness.workspace(GuestRun.of(files, ARGV, new byte[0], budget(30)))) {
            Path app = fs.getPath("/app");
            assertThat(Files.size(app.resolve("f4.js"))).isEqualTo(10_000);
            assertThatThrownBy(() -> Files.write(app.resolve("fill"), new byte[64 * 1024])).isInstanceOf(IOException.class);
        }
    }

    @Test
    void aCleanReturnIsAnExitWithZeroAndTheEnginesOwnEndingsAreRead() {
        RunHarness harness = harness();
        engine.start = io -> {
            write(io, "before\n");
            throw new ScriptedEngine.Exit(3);
        };
        RunOutput exit = run(harness, budget(30));
        assertThat(exit.termination()).isEqualTo(Termination.EXITED);
        assertThat(exit.exitCode()).isEqualTo(3);
        assertThat(out(exit)).isEqualTo("before\n");

        engine.start = io -> {
            write(io, "@@started@@\n");
            throw new ScriptedEngine.Trap("unreachable");
        };
        RunOutput trap = run(harness, budget(30));
        assertThat(trap.termination()).isEqualTo(Termination.TRAP);
        assertThat(trap.trapMessage()).isEqualTo("Trap: unreachable");
        assertThat(out(trap)).isEqualTo("@@started@@\n");
    }

    @Test
    void aStopAtTheBudgetInterruptsOnlyTheStartAndKeepsWhatWasWritten() {
        RunHarness harness = harness();
        engine.start = io -> {
            write(io, "@@started@@\n");
            ScriptedEngine.loopUntilInterrupted();
        };
        long started = System.nanoTime();
        RunOutput output = run(harness, budget(1));
        double seconds = (System.nanoTime() - started) / 1e9;
        assertThat(output.termination()).isEqualTo(Termination.BUDGET);
        assertThat(out(output)).isEqualTo("@@started@@\n");
        assertThat(seconds).isLessThan(1 + EngineSettings.DEFAULT_STOP_GRACE.toSeconds());
        assertThat(engine.instancesClosed).as("the instance is closed on the thread's way out").hasValue(1);
        assertThat(harness.strayRuns()).isZero();
        engine.start = io -> write(io, "again");
        assertThat(out(run(harness, budget(30)))).as("the next run answers").isEqualTo("again");
    }

    @Test
    void aStopDuringSetUpIsNeverDeliveredThereAndTheInstanceIsClosedUnstarted() throws Exception {
        RunHarness harness = harness();
        CountDownLatch release = new CountDownLatch(1);
        AtomicBoolean interrupted = new AtomicBoolean();
        engine.instantiate = io -> {
            boolean waiting = true;
            while (waiting) {
                try {
                    release.await();
                    waiting = false;
                } catch (InterruptedException e) {
                    interrupted.set(true);
                }
            }
            if (Thread.currentThread().isInterrupted()) {
                interrupted.set(true);
            }
        };
        engine.start = io -> write(io, "@@started@@\n");
        Thread releaser = new Thread(() -> {
            try {
                Thread.sleep(2000);
            } catch (InterruptedException ignored) {
                // released at once
            }
            release.countDown();
        });
        releaser.start();
        try {
            RunOutput output = run(harness, budget(1));
            releaser.join();
            assertThat(output.termination()).isEqualTo(Termination.BUDGET);
            assertThat(output.stdoutLength()).as("never started").isZero();
            assertThat(interrupted).as("no interrupt reached the set-up").isFalse();
            assertThat(engine.started).hasValue(0);
            assertThat(engine.instancesClosed).as("built, then closed without being started").hasValue(1);
            assertThat(harness.strayRuns()).isZero();
        } finally {
            release.countDown();
        }
    }

    @Test
    void strayRunsPastTheirGraceRefuseNewRunsUntilTheyEnd() throws Exception {
        RunHarness strict = harness(new EngineSettings(Duration.ofMillis(200), 1));
        CountDownLatch hold = new CountDownLatch(1);
        engine.start = io -> {
            write(io, "@@started@@\n");
            boolean waiting = true;
            while (waiting) {
                try {
                    hold.await();
                    waiting = false;
                } catch (InterruptedException ignored) {
                    // Ignored on purpose: an engine path that does not answer interrupts.
                }
            }
        };
        try {
            RunOutput stopped = run(strict, budget(1));
            assertThat(stopped.termination()).isEqualTo(Termination.BUDGET);
            assertThat(out(stopped)).isEqualTo("@@started@@\n");
            assertThat(strict.strayRuns()).isEqualTo(1);
            assertThatThrownBy(() -> run(strict, budget(30))).isInstanceOf(GuestUnavailableException.class)
                .hasMessageContaining("stopped runs");
            engine.start = io -> write(io, "fine");
            hold.countDown();
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
            while (strict.strayRuns() > 0 && System.nanoTime() < deadline) {
                Thread.sleep(20);
            }
            assertThat(strict.strayRuns()).isZero();
            assertThat(out(run(strict, budget(30)))).isEqualTo("fine");
        } finally {
            hold.countDown();
        }
    }

    @Test
    void closeStopsEveryRunInFlightAndAClosedHarnessRunsNothing() throws Exception {
        RunHarness closing = harness();
        engine.start = io -> {
            write(io, "@@started@@\n");
            ScriptedEngine.loopUntilInterrupted();
        };
        ExecutorService pool = Executors.newFixedThreadPool(3);
        try {
            List<Future<RunOutput>> futures = new ArrayList<>();
            for (int i = 0; i < 3; i++) {
                futures.add(pool.submit(() -> run(closing, budget(60))));
            }
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
            while (engine.started.get() < 3 && System.nanoTime() < deadline) {
                Thread.sleep(10);
            }
            closing.close();
            for (Future<RunOutput> future : futures) {
                RunOutput output = future.get(30, TimeUnit.SECONDS);
                assertThat(output.termination()).isEqualTo(Termination.INTERRUPTED);
                assertThat(out(output)).as("what it wrote is handed back").isEqualTo("@@started@@\n");
            }
        } finally {
            pool.shutdownNow();
        }
        int prepared = engine.prepared.get();
        RunOutput after = run(closing, budget(5));
        assertThat(after.termination()).isEqualTo(Termination.INTERRUPTED);
        assertThat(after.stdoutLength()).isZero();
        assertThat(engine.prepared).as("nothing is made for a closed harness").hasValue(prepared);
    }

    @Test
    void aCallerInterruptStopsTheRunAndTheInterruptIsKept() throws Exception {
        RunHarness harness = harness();
        engine.start = io -> {
            write(io, "@@started@@\n");
            ScriptedEngine.loopUntilInterrupted();
        };
        AtomicReference<RunOutput> result = new AtomicReference<>();
        AtomicBoolean kept = new AtomicBoolean();
        Thread caller = new Thread(() -> {
            result.set(run(harness, budget(60)));
            kept.set(Thread.currentThread().isInterrupted());
        });
        caller.start();
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (engine.started.get() < 1 && System.nanoTime() < deadline) {
            Thread.sleep(10);
        }
        caller.interrupt();
        caller.join(15_000);
        assertThat(caller.isAlive()).isFalse();
        assertThat(result.get().termination()).isEqualTo(Termination.INTERRUPTED);
        assertThat(out(result.get())).isEqualTo("@@started@@\n");
        assertThat(kept).as("the caller's interrupt is kept").isTrue();
    }

    @Test
    void aPassedCapIsOutputCapWhateverTheEngineMakesOfItsException() {
        RunHarness harness = harness();
        Budget small = new Budget(30, 32L << 20, 10, 10);
        engine.start = io -> {
            try {
                write(io, "0123456789AB");
            } catch (RuntimeException e) {
                // A machine that wraps what a host function threw.
                throw new IllegalStateException("wrapped", e);
            }
        };
        RunOutput wrapped = run(harness, small);
        assertThat(wrapped.termination()).isEqualTo(Termination.OUTPUT_CAP);
        assertThat(out(wrapped)).isEqualTo("0123456789");

        engine.start = io -> {
            try {
                io.stderr().write(new byte[11]);
            } catch (RuntimeException swallowed) {
                // A layer that swallows it and lets the guest go on: the stream still knows.
            }
        };
        RunOutput swallowed = run(harness, small);
        assertThat(swallowed.termination()).isEqualTo(Termination.OUTPUT_CAP);
        assertThat(swallowed.stderrLength()).isEqualTo(10);
    }

    @Test
    void aFailureBeforeTheStartIsTheRuntimesNamingWhereItRan() {
        RunHarness harness = harness();
        engine.instantiate = io -> {
            throw new IllegalStateException("cannot link the module");
        };
        assertThatThrownBy(() -> run(harness, budget(30))).isInstanceOf(GuestUnavailableException.class)
            .hasMessageContaining("could not be started on the scripted runner").hasMessageContaining("cannot link the module");
        engine.instantiate = io -> {
            throw new UnsatisfiedLinkError("no native library");
        };
        assertThatThrownBy(() -> run(harness, budget(30))).isInstanceOf(GuestUnavailableException.class)
            .hasMessageContaining("no native library");
        engine.instantiate = io -> {
            throw new AssertionError("a bug");
        };
        assertThatThrownBy(() -> run(harness, budget(30))).as("another Error is not hidden").isInstanceOf(AssertionError.class);
        assertThat(engine.started).hasValue(0);
    }

    @Test
    void theJvmOutOfHeapIsTheHostsStopBeforeOrAfterTheStart() {
        RunHarness harness = harness();
        engine.start = io -> {
            write(io, "@@started@@\n");
            throw new OutOfMemoryError("Java heap space");
        };
        RunOutput after = run(harness, budget(30));
        assertThat(after.termination()).isEqualTo(Termination.INTERRUPTED);
        assertThat(after.trapMessage()).contains("heap");
        assertThat(out(after)).isEqualTo("@@started@@\n");

        engine.start = io -> {
            throw new ScriptedEngine.OutOfHeap();
        };
        assertThat(run(harness, budget(30)).termination()).as("the engine's wrap of it").isEqualTo(Termination.INTERRUPTED);

        engine.start = io -> { };
        engine.instantiate = io -> {
            throw new IllegalStateException("set-up", new OutOfMemoryError());
        };
        assertThat(run(harness, budget(30)).termination()).as("never an unavailable program").isEqualTo(Termination.INTERRUPTED);
    }

    @Test
    void afterTheStartAStackOverflowTrapsALinkageErrorIsUnavailableAndOtherFaultsTrap() {
        RunHarness harness = harness();
        engine.start = io -> {
            throw new StackOverflowError();
        };
        RunOutput overflow = run(harness, budget(30));
        assertThat(overflow.termination()).isEqualTo(Termination.TRAP);
        assertThat(overflow.trapMessage()).isEqualTo("call stack exhausted (JVM stack)");

        engine.start = io -> {
            throw new NoClassDefFoundError("run/Missing");
        };
        assertThatThrownBy(() -> run(harness, budget(30))).isInstanceOf(GuestUnavailableException.class)
            .hasMessageContaining("The scripted runner failed to link during a run");

        engine.start = io -> {
            throw new AssertionError("a bug");
        };
        assertThatThrownBy(() -> run(harness, budget(30))).isInstanceOf(AssertionError.class);

        engine.start = io -> {
            throw new UnsupportedOperationException("a WASI call the layer does not handle");
        };
        RunOutput odd = run(harness, budget(30));
        assertThat(odd.termination()).as("a failed run, never an answer").isEqualTo(Termination.TRAP);
        assertThat(odd.trapMessage()).contains("a WASI call the layer does not handle");
    }

    @Test
    void theEnginesWordForAnInterruptIsAnInterruption() {
        engine.start = io -> {
            throw new ScriptedEngine.Interrupted();
        };
        assertThat(run(harness(), budget(30)).termination()).isEqualTo(Termination.INTERRUPTED);
    }

    @Test
    void theEngineRefusesBeforeAnythingIsMade() {
        engine.refusePdf = true;
        GuestRun pdf = GuestRun.of(files("datum-pdf-program.js", "pdf".getBytes(StandardCharsets.UTF_8), "print(1);"), ARGV, new byte[0],
            budget(30));
        assertThatThrownBy(() -> harness().run(pdf))
            .isInstanceOf(GuestUnavailableException.class).hasMessageContaining("no PDF program");
        assertThat(engine.prepared).hasValue(0);
    }

    @Test
    void theHarnessReportsTheEnginesInfoAndItsStrays() {
        RunHarness harness = harness();
        assertThat(harness.engineInfo().id()).isEqualTo("scripted");
        assertThat(harness.strayRuns()).isZero();
        assertThat(harness.stopGrace()).isEqualTo(EngineSettings.DEFAULT_STOP_GRACE);
        GuestRuntime silent = run -> RunOutput.exited(0, null, null);
        assertThat(silent.engineInfo().version()).isEqualTo(EngineInfo.UNKNOWN);
        assertThat(silent.engineInfo().mode()).isEqualTo(EngineInfo.UNKNOWN);
        assertThat(silent.engineInfo().isBytecode()).as("nothing known, so not bytecode").isFalse();
        assertThat(silent.strayRuns()).as("a runtime that does not count them").isEqualTo(-1);
    }

    @Test
    void settingsAndInfoRefuseNonsense() {
        assertThatThrownBy(() -> new EngineSettings(Duration.ofSeconds(-1), 2)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new EngineSettings(Duration.ofSeconds(5), 0)).isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("at least 1");
        assertThat(EngineSettings.defaults().maxStrays()).isGreaterThanOrEqualTo(2);
        assertThatThrownBy(() -> new EngineInfo(" ", null, null, null)).isInstanceOf(IllegalArgumentException.class);
        EngineInfo bare = new EngineInfo("x", null, "", null);
        assertThat(bare.version()).isEqualTo(EngineInfo.UNKNOWN);
        assertThat(bare.mode()).isEqualTo(EngineInfo.UNKNOWN);
        assertThat(bare.notes()).isEmpty();
        assertThat(new EngineInfo("x", "1", EngineInfo.BYTECODE, "").isBytecode()).isTrue();
        assertThatThrownBy(() -> new GuestEngine.Ending(Termination.BUDGET, -1, null)).isInstanceOf(IllegalArgumentException.class);
    }

    /** One spelling of a mode, whatever the runtime wrote: the bytecode refusal and the reports read the same string. */
    @Test
    void aModeIsTrimmedAndLowerCasedSoBytecodeIsBytecodeInAnySpelling() {
        for (String spelling : new String[] {"BYTECODE", " Bytecode ", "bytecode", "\tbyteCODE\n"}) {
            EngineInfo info = new EngineInfo("x", "1", spelling, "");
            assertThat(info.mode()).as(spelling).isEqualTo(EngineInfo.BYTECODE);
            assertThat(info.isBytecode()).as(spelling).isTrue();
        }
        assertThat(new EngineInfo("x", "1", " JFFI ", "").mode()).isEqualTo("jffi");
        assertThat(new EngineInfo("x", "1", "Panama", "").isBytecode()).isFalse();
        assertThat(new EngineInfo("x", "1", "  ", "").mode()).isEqualTo(EngineInfo.UNKNOWN);
    }

    /**
     * A timed run hands back where its time went, measured around the engine's own three calls; an
     * untimed run carries none; a run stopped at its budget is measured up to the answer, with a step it never reached unknown.
     */
    @Test
    void aTimedRunHandsBackItsTimingsAndAnUntimedOneNone() {
        engine.instantiate = io -> Thread.sleep(20);
        engine.start = io -> {
            Thread.sleep(40);
            write(io, "done");
        };
        RunHarness harness = harness();
        GuestRun untimed = guestRun(budget(5));
        assertThat(harness.run(untimed).timings()).isNull();

        GuestRun timed = new GuestRun(untimed.appFiles(), untimed.argv(), untimed.stdin(), untimed.budget(), true);
        assertThat(timed.toString()).endsWith("; timed]");
        RunOutput output = harness.run(timed);
        assertThat(out(output)).isEqualTo("done");
        RunTimings timings = output.timings();
        assertThat(timings).isNotNull();
        assertThat(timings.prepareNanos()).isGreaterThanOrEqualTo(0);
        assertThat(timings.instantiateNanos()).isGreaterThanOrEqualTo(TimeUnit.MILLISECONDS.toNanos(15));
        assertThat(timings.startNanos()).isGreaterThanOrEqualTo(TimeUnit.MILLISECONDS.toNanos(35));
        assertThat(RunTimings.millis(timings.startNanos())).isGreaterThanOrEqualTo(35.0);
        assertThat(RunTimings.millis(RunTimings.NOT_RUN)).isEqualTo(-1);

        engine.instantiate = io -> { };
        engine.start = io -> Thread.sleep(10_000);
        RunOutput stopped = harness(new EngineSettings(Duration.ofMillis(100), 4)).run(
            new GuestRun(untimed.appFiles(), untimed.argv(), untimed.stdin(), budget(1), true));
        assertThat(stopped.termination()).isEqualTo(Termination.BUDGET);
        assertThat(stopped.timings()).isNotNull();
        assertThat(stopped.timings().startNanos()).as("measured up to the answer").isGreaterThanOrEqualTo(TimeUnit.MILLISECONDS.toNanos(900));
        assertThat(new RunTimings(-5, 1, 2).prepareNanos()).isEqualTo(RunTimings.NOT_RUN);
    }
}
