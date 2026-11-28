package com.argusvane.datum.sandbox.runtime;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.core.DatumEventPublisher;
import com.argusvane.datum.core.ProgramUnavailableException;
import com.argusvane.datum.sandbox.runtime.EngineBytecodeException;
import com.argusvane.datum.sandbox.wasi.EngineInfo;
import com.argusvane.datum.sandbox.wasi.EngineSelectionException;
import com.argusvane.datum.sandbox.protocol.ProgramRunner;
import com.argusvane.datum.sandbox.protocol.HostOptions;
import com.argusvane.datum.sandbox.protocol.ProgramLimits;
import com.argusvane.datum.sandbox.protocol.RunLog;
import com.argusvane.datum.sandbox.protocol.SandboxException;
import com.argusvane.datum.sandbox.wasi.GuestRuntime;
import com.argusvane.datum.sandbox.wasi.RunOutput;
import com.argusvane.datum.sandbox.wasi.Termination;
import com.argusvane.datum.sandbox.events.SandboxReadyEvent;
import com.argusvane.datum.sandbox.events.SandboxRunInterruptedEvent;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.node.ObjectNode;

/** The runtime's lifecycle over a test runtime: the gate, the warm-up, fail-fast, the slots and the shutdown grace. */
class DatumSandboxTest {

    private final TestRuntime engine = new TestRuntime();
    private final List<Object> events = Collections.synchronizedList(new ArrayList<>());
    private final ExecutorService callers = Executors.newCachedThreadPool();
    private DatumSandbox runtime;

    @AfterEach
    void tearDown() {
        if (runtime != null) {
            runtime.stop();
        }
        callers.shutdownNow();
    }

    private DatumSandbox runtime(boolean failFast, int warmUps, ProgramLimits limits, Duration grace) {
        runtime = DatumSandbox.builder().runtime(engine).store(Programs.packaged().store()).limits(limits).hostOptions(HostOptions.defaults())
            .settings(TestSettings.of("endive", failFast, warmUps, grace, 1, Duration.ZERO)).events(events::add).runLog(RunLog.slf4j()).build();
        return runtime;
    }

    private DatumSandbox runtime(boolean failFast) {
        return runtime(failFast, 2, ProgramLimits.defaults(), Duration.ofSeconds(1));
    }

    private static ObjectNode context() {
        return TestRuntime.json("{\"formId\":\"contact\",\"form\":{\"id\":\"root\",\"type\":\"form\",\"configuration\":{},\"children\":{\"content\":[]}},"
            + "\"values\":{},\"locale\":\"en\"}");
    }

    @Test
    void startProvesBothProgramsWarmsUpAndSaysItIsReady() {
        DatumSandbox started = runtime(true);
        started.start();
        assertThat(started.isRunning()).isTrue();
        assertThat(engine.sandboxProbes()).isEqualTo(1);
        assertThat(engine.pdfProbes()).isEqualTo(1);
        assertThat(engine.smokes()).isEqualTo(2);
        SandboxStatus status = started.status();
        assertThat(status.state()).isEqualTo(SandboxStatus.State.UP);
        assertThat(status.isUp()).isTrue();
        assertThat(status.details()).containsEntry("sandboxAbi", "1.0.0").containsEntry("pdfAbi", "1.0.0").containsEntry("engineMode", "jffi")
            .containsEntry("engine", TestRuntime.class.getName()).containsEntry("engineRelease", "test").containsEntry("pdfCapable", true);
        assertThat(events).singleElement().isInstanceOfSatisfying(SandboxReadyEvent.class, ready -> {
            assertThat(ready.engine().id()).isEqualTo(TestRuntime.class.getName());
            assertThat(ready.engine().mode()).isEqualTo("jffi");
            assertThat(ready.sandboxAbi()).isEqualTo("1.0.0");
            assertThat(ready.pdfAbi()).isEqualTo("1.0.0");
        });
        assertThat(started.sandbox()).isNotNull();
        assertThat(started.pdfProgram()).isNotNull();
    }

    @Test
    void aFailedProbeWithFailFastRefusesTheContextStart() {
        engine.sandboxProbeFails = true;
        DatumSandbox refusing = runtime(true);
        assertThatThrownBy(refusing::start).isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("abi_mismatch").hasMessageContaining("datum.runtime.fail-fast=false");
        assertThat(refusing.isRunning()).isFalse();
        assertThat(refusing.status().state()).isEqualTo(SandboxStatus.State.DOWN);
        assertThat(events).isEmpty();
    }

    @Test
    void aFailedProbeWithoutFailFastIsDownWithTypedRefusalsUntilARecheckPasses() {
        engine.sandboxProbeFails = true;
        DatumSandbox down = runtime(false);
        down.start();
        assertThat(down.isRunning()).isTrue();
        SandboxStatus status = down.status();
        assertThat(status.state()).isEqualTo(SandboxStatus.State.DOWN);
        assertThat(status.isUp()).isFalse();
        assertThat(status.reason()).contains("abi_mismatch");
        assertThat(down.sandboxOrNull()).isNull();
        assertThatThrownBy(down::sandbox).isInstanceOf(ProgramUnavailableException.class)
            .satisfies(e -> assertThat(((ProgramUnavailableException) e).httpStatus()).isEqualTo(503));
        assertThatThrownBy(down::pdfProgram).isInstanceOf(ProgramUnavailableException.class);

        engine.sandboxProbeFails = false;
        SandboxStatus rechecked = down.recheck();
        assertThat(rechecked.state()).isEqualTo(SandboxStatus.State.UP);
        assertThat(down.sandbox()).isNotNull();
        assertThat(events).hasSize(1);
    }

    @Test
    void aWarmUpWithTheWrongVerdictIsAFailedStart() {
        engine.smokeWrong = true;
        assertThatThrownBy(runtime(true)::start).isInstanceOf(IllegalStateException.class).hasMessageContaining("Warm-up run 1");
    }

    @Test
    void aStalePdfProgramFailsLikeTheSandboxButABytecodeRuntimeOnlyLosesThePdfPath() {
        engine.pdfProbeFails = true;
        assertThatThrownBy(runtime(true)::start).isInstanceOf(IllegalStateException.class).hasMessageContaining("PDF program");

        TestRuntime bytecode = new TestRuntime();
        bytecode.mode = "bytecode";
        bytecode.pdfProbeFails = true;
        // On bytecode by intent: the allowance is set, so the runtime starts.
        runtime = DatumSandbox.builder().runtime(bytecode).store(Programs.packaged().store()).limits(ProgramLimits.defaults()).hostOptions(HostOptions.defaults())
            .settings(TestSettings.of("endive", true, 0, Duration.ofSeconds(1), 1, Duration.ZERO, SandboxSettings.DEFAULT_STARTUP_BUDGET, true))
            .events(events::add).runLog(RunLog.slf4j()).build();
        runtime.start();
        assertThat(runtime.status().state()).isEqualTo(SandboxStatus.State.UP);
        assertThat(runtime.status().pdfUnavailable()).contains("bytecode");
        // A fixed sentence: the engine's free-text notes (a passed-over runner's exception text, which can name a file
        // path) stay in engineNotes, which the actuator read strips.
        assertThat(runtime.status().pdfUnavailable())
            .isEqualTo("The " + TestRuntime.class.getName() + " engine cannot run the PDF program here (mode bytecode).")
            .doesNotContain(bytecode.engineInfo().notes());
        assertThat(bytecode.pdfProbes()).isZero();
        assertThatThrownBy(runtime::pdfProgram).isInstanceOf(ProgramUnavailableException.class).hasMessageContaining("bytecode");
        assertThat(runtime.sandbox()).isNotNull();
    }

    // ---- the bytecode allowance (datum.runtime.allow-bytecode, default false)

    private DatumSandbox runtime(TestRuntime delegate, SandboxSettings settings) {
        runtime = DatumSandbox.builder().runtime(delegate).store(Programs.packaged().store()).limits(ProgramLimits.defaults())
            .hostOptions(HostOptions.defaults()).settings(settings).events(events::add).runLog(RunLog.slf4j()).build();
        return runtime;
    }

    private static SandboxSettings settingsAllowingBytecode(boolean allowed) {
        return TestSettings.of("endive", true, 2, Duration.ofSeconds(1), 1, Duration.ZERO, SandboxSettings.DEFAULT_STARTUP_BUDGET, allowed);
    }

    private static SandboxSettings settings(boolean failFast) {
        return TestSettings.of("endive", failFast, 2, Duration.ofSeconds(1), 1, Duration.ZERO);
    }

    @Test
    void theAllowanceIsOffByDefault() {
        assertThat(settings(true).engine().allowBytecode()).isFalse();
        assertThat(TestSettings.of("endive", true, 0, Duration.ofSeconds(1), 1, Duration.ZERO, Duration.ofSeconds(30)).engine().allowBytecode())
            .isFalse();
        assertThat(DatumSandbox.ALLOW_BYTECODE).isEqualTo("datum.runtime.allow-bytecode");
    }

    /**
     * A bytecode engine without the allowance never starts, whatever fail-fast says: the platform does not change between
     * two rechecks, so a DOWN runtime waiting for one would never come up, and a fail-fast=false host must not serve on bytecode.
     * Nothing is proved or run first, and the runtime stays DOWN (not ready) refusing every run.
     */
    @Test
    void aBytecodeEngineRefusesToStartByDefaultWhateverFailFastSays() {
        for (boolean failFast : new boolean[] {true, false}) {
            TestRuntime bytecode = new TestRuntime();
            bytecode.mode = EngineInfo.BYTECODE;
            DatumSandbox refusing = runtime(bytecode, settings(failFast));
            assertThatThrownBy(refusing::start).as("fail-fast " + failFast).isInstanceOfSatisfying(EngineBytecodeException.class, e -> {
                assertThat(e.property()).isEqualTo("datum.runtime.allow-bytecode");
                assertThat(e.engine().mode()).isEqualTo(EngineInfo.BYTECODE);
                assertThat(e.getMessage()).contains("datum.runtime.allow-bytecode is false").contains(bytecode.engineInfo().notes());
                assertThat(e.action()).contains("native code").contains("datum.runtime.allow-bytecode=true");
            });
            assertThat(refusing.isRunning()).isFalse();
            assertThat(bytecode.sandboxProbes()).as("nothing is proved on a refused engine").isZero();
            assertThat(bytecode.smokes()).isZero();
            SandboxStatus status = refusing.status();
            assertThat(status.state()).isEqualTo(SandboxStatus.State.DOWN);
            assertThat(status.isUp()).isFalse();
            // A fixed sentence: the engine's notes (which can name a native library's path) stay out of what a read answers.
            assertThat(status.reason()).isEqualTo("The " + TestRuntime.class.getName()
                + " engine runs the programs as JVM bytecode here, and datum.runtime.allow-bytecode is false.")
                .doesNotContain(bytecode.engineInfo().notes());
            assertThat(refusing.sandboxOrNull()).isNull();
            assertThatThrownBy(refusing::sandbox).isInstanceOf(ProgramUnavailableException.class).hasMessageContaining("allow-bytecode");
            assertThatThrownBy(refusing::pdfProgram).isInstanceOf(ProgramUnavailableException.class);
            assertThat(refusing.runtime().run(Programs.packaged().store().load().sandbox(), "print(1);", List.of("qjs"), new byte[0],
                new com.argusvane.datum.sandbox.wasi.Budget(5, 32L << 20, 1024, 1024)).termination()).isEqualTo(Termination.INTERRUPTED);
            assertThat(refusing.recheck().state()).as("a recheck cannot bring it up").isEqualTo(SandboxStatus.State.DOWN);
            assertThatThrownBy(refusing::start).as("nor a second start").isInstanceOf(EngineBytecodeException.class);
            assertThat(bytecode.sandboxProbes()).isZero();
            assertThat(events).isEmpty();
        }
    }

    /**
     * An application's own runtime may spell the mode as it likes: EngineInfo reads one spelling, so a runtime that says
     * "BYTECODE" or " Bytecode " is refused exactly as Endive's "bytecode" is, and health would report "bytecode".
     */
    @Test
    void aBytecodeModeInAnySpellingIsRefusedToo() {
        for (String spelling : new String[] {"BYTECODE", " Bytecode "}) {
            TestRuntime bytecode = new TestRuntime();
            bytecode.mode = spelling;
            DatumSandbox refusing = runtime(bytecode, settings(true));
            assertThat(refusing.engineInfo().mode()).as("[" + spelling + "]").isEqualTo(EngineInfo.BYTECODE);
            assertThatThrownBy(refusing::start).as("[" + spelling + "]").isInstanceOfSatisfying(EngineBytecodeException.class,
                e -> assertThat(e.engine().mode()).isEqualTo(EngineInfo.BYTECODE));
            assertThat(refusing.isRunning()).isFalse();
            assertThat(bytecode.sandboxProbes()).isZero();
            assertThat(refusing.status().state()).isEqualTo(SandboxStatus.State.DOWN);
            assertThat(refusing.status().details()).containsEntry("engineMode", "bytecode");
        }
    }

    /**
     * A refused start the host catches leaves nothing behind: the runtime's pool is shut down and none of its threads is
     * alive. (The pool starts no thread until a run is submitted and a refused runtime accepts none, so the thread check
     * alone would pass for a pool that was never shut down; the pool's own state is read as well.)
     */
    @Test
    void aRefusedStartLeavesNoPoolAndNoThreadOfIt() throws Exception {
        List<Thread> before = poolThreads();
        TestRuntime bytecode = new TestRuntime();
        bytecode.mode = EngineInfo.BYTECODE;
        DatumSandbox refusing = runtime(bytecode, settings(true));
        assertThatThrownBy(refusing::start).isInstanceOf(EngineBytecodeException.class);
        // A run that arrives after the refusal is answered without a pool thread.
        assertThatThrownBy(refusing::sandbox).isInstanceOf(ProgramUnavailableException.class);
        java.lang.reflect.Field field = DatumSandbox.class.getDeclaredField("pool");
        field.setAccessible(true);
        java.util.concurrent.ThreadPoolExecutor pool = (java.util.concurrent.ThreadPoolExecutor) field.get(refusing);
        assertThat(pool.isShutdown()).as("the refused runtime's pool is shut down").isTrue();
        assertThat(pool.getPoolSize()).isZero();
        assertThat(pool.awaitTermination(5, TimeUnit.SECONDS)).isTrue();
        List<Thread> after = poolThreads();
        after.removeAll(before);
        assertThat(after).as("threads of the refused runtime's pool").isEmpty();
    }

    /** The live threads named after a runtime pool ({@code datum-sandbox-<pool>-<n>}). */
    private static List<Thread> poolThreads() {
        List<Thread> found = new ArrayList<>();
        for (Thread thread : Thread.getAllStackTraces().keySet()) {
            if (thread.isAlive() && thread.getName().startsWith("datum-sandbox-")) {
                found.add(thread);
            }
        }
        return found;
    }

    @Test
    void withTheAllowanceABytecodeEngineStarts() {
        TestRuntime bytecode = new TestRuntime();
        bytecode.mode = EngineInfo.BYTECODE;
        DatumSandbox started = runtime(bytecode, settingsAllowingBytecode(true));
        started.start();
        SandboxStatus status = started.status();
        assertThat(status.state()).isEqualTo(SandboxStatus.State.UP);
        assertThat(status.details()).containsEntry("engineMode", "bytecode").containsEntry("pdfCapable", false);
        assertThat(status.pdfUnavailable()).contains("mode bytecode");
        assertThat(bytecode.smokes()).isEqualTo(2);
        assertThat(started.sandbox()).isNotNull();
        assertThatThrownBy(started::pdfProgram).isInstanceOf(ProgramUnavailableException.class);
        assertThat(events).singleElement().isInstanceOf(SandboxReadyEvent.class);
    }

    @Test
    void aNativeEngineIsUnaffectedByTheAllowance() {
        for (boolean allowed : new boolean[] {false, true}) {
            TestRuntime jffi = new TestRuntime();
            DatumSandbox started = runtime(jffi, settingsAllowingBytecode(allowed));
            started.start();
            assertThat(started.status().state()).as("allow-bytecode " + allowed).isEqualTo(SandboxStatus.State.UP);
            assertThat(started.pdfProgram()).isNotNull();
            started.stop();
        }
        // A runtime that reports no mode (unknown) is not on bytecode as far as anyone can tell, and starts.
        DatumSandbox unknown = DatumSandbox.builder().runtime(new UnreportedRuntime(engine)).store(Programs.packaged().store())
            .limits(ProgramLimits.defaults()).hostOptions(HostOptions.defaults()).settings(settings(true)).events(events::add)
            .runLog(RunLog.slf4j()).build();
        runtime = unknown;
        unknown.start();
        assertThat(unknown.engineInfo().mode()).isEqualTo(EngineInfo.UNKNOWN);
        assertThat(unknown.status().state()).isEqualTo(SandboxStatus.State.UP);
    }

    /** The test runtime's runs without its engine report: the default {@code engineInfo()} of an application's runtime. */
    private static final class UnreportedRuntime implements com.argusvane.datum.sandbox.wasi.GuestRuntime {

        private final TestRuntime runs;

        UnreportedRuntime(TestRuntime runs) {
            this.runs = runs;
        }

        @Override
        public com.argusvane.datum.sandbox.wasi.RunOutput run(com.argusvane.datum.sandbox.wasi.GuestRun run) {
            return runs.run(run);
        }
    }

    @Test
    void withoutAGuestRuntimeTheStartNamesTheFix() {
        runtime = DatumSandbox.builder().withoutRuntime().store(Programs.packaged().store()).limits(ProgramLimits.defaults()).hostOptions(HostOptions.defaults())
            .settings(TestSettings.of("endive", true, 0, Duration.ofSeconds(1), 1, Duration.ZERO)).events(events::add).runLog(RunLog.slf4j()).build();
        assertThatThrownBy(runtime::start).isInstanceOf(IllegalStateException.class).hasMessageContaining("datum-sandbox-endive");
    }

    @Test
    void aValidationIsBusyOnceEverySlotIsTakenForTheWait() throws Exception {
        ProgramLimits one = ProgramLimits.builder().validationConcurrency(1).validationWait(0).build();
        DatumSandbox busy = runtime(true, 0, one, Duration.ofSeconds(1));
        busy.start();
        engine.hold = new CountDownLatch(1);
        engine.holding = new CountDownLatch(1);
        Future<?> first = callers.submit(() -> busy.sandbox().validate(context(), List.of(), false));
        assertThat(engine.holding.await(5, TimeUnit.SECONDS)).isTrue();
        assertThat(busy.status().validationSlotsFree()).isZero();
        assertThat(busy.status().inFlight()).isEqualTo(1);
        assertThatThrownBy(() -> busy.sandbox().validate(context(), List.of(), false))
            .isInstanceOf(SandboxException.class)
            .satisfies(e -> {
                assertThat(((SandboxException) e).reason()).isEqualTo(SandboxException.Reason.BUSY);
                assertThat(((SandboxException) e).code()).isEqualTo("server.busy");
            });
        engine.hold.countDown();
        first.get(5, TimeUnit.SECONDS);
        assertThat(busy.status().validationSlotsFree()).isEqualTo(1);
    }

    @Test
    void theShutdownGraceCancelsAHangingRunAndRefusesNewOnes() throws Exception {
        DatumSandbox stopping = runtime(true, 0, ProgramLimits.defaults(), Duration.ofMillis(300));
        stopping.start();
        engine.hold = new CountDownLatch(1);
        engine.holding = new CountDownLatch(1);
        Future<?> hanging = callers.submit(() -> stopping.sandbox().validate(context(), List.of(), false));
        assertThat(engine.holding.await(5, TimeUnit.SECONDS)).isTrue();
        // The runtime counts the run as in flight (it registers it before the pool thread starts it): a
        // stop that began a moment earlier would otherwise have nothing to wait for.
        assertThat(stopping.status().inFlight()).isEqualTo(1);

        long started = System.nanoTime();
        stopping.stop();
        long took = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started);
        assertThat(took).isGreaterThanOrEqualTo(250).isLessThan(5000);
        assertThat(stopping.isRunning()).isFalse();
        assertThat(stopping.status().state()).isEqualTo(SandboxStatus.State.STOPPED);

        assertThatThrownBy(() -> hanging.get(5, TimeUnit.SECONDS))
            .hasCauseInstanceOf(SandboxException.class)
            .satisfies(e -> {
                SandboxException cause = (SandboxException) e.getCause();
                assertThat(cause.reason()).isEqualTo(SandboxException.Reason.INTERRUPTED);
                assertThat(cause.httpStatus()).isEqualTo(503);
            });
        // A stopped runtime answers 503, whether asked for its service or (holding one) for a run.
        assertThatThrownBy(stopping::sandbox).isInstanceOf(ProgramUnavailableException.class);
        engine.hold = null;
        assertThat(stopping.runtime().run(com.argusvane.datum.sandbox.protocol.Program.of(
            com.argusvane.datum.sandbox.protocol.Program.Kind.SANDBOX, new byte[] {1}), "", List.of("qjs"), new byte[0],
            ProgramLimits.defaults().validationBudget()).termination()).isEqualTo(Termination.INTERRUPTED);
    }

    @Test
    void aRunStoppedAtItsBudgetPublishesItsEvent() {
        DatumSandbox started = runtime(true, 0, ProgramLimits.defaults(), Duration.ofSeconds(1));
        started.start();
        engine.terminate = Termination.BUDGET;
        assertThatThrownBy(() -> started.sandbox().validate(context(), List.of(), false)).isInstanceOf(SandboxException.class);
        assertThat(events).filteredOn(SandboxRunInterruptedEvent.class::isInstance).singleElement()
            .isInstanceOfSatisfying(SandboxRunInterruptedEvent.class, event -> {
                assertThat(event.program()).isEqualTo("sandbox");
                assertThat(event.reason()).isEqualTo("budget");
            });
    }

    @Test
    void aReadyListenerThatThrowsLeavesTheRuntimeUp() {
        // Through the host's default (guarded) publisher listeners are logged and never change the answer: a failing metrics
        // push must not fail the start.
        runtime = DatumSandbox.builder().runtime(engine).store(Programs.packaged().store()).limits(ProgramLimits.defaults()).hostOptions(HostOptions.defaults())
            .settings(TestSettings.of("endive", true, 0, Duration.ofSeconds(1), 1, Duration.ZERO)).events(DatumEventPublisher.guarded(event -> {
                events.add(event);
                throw new IllegalStateException("metrics push failed");
            })).runLog(RunLog.slf4j()).build();
        runtime.start();
        assertThat(runtime.isRunning()).isTrue();
        assertThat(runtime.status().state()).isEqualTo(SandboxStatus.State.UP);
        assertThat(runtime.recheck().state()).isEqualTo(SandboxStatus.State.UP);
        assertThat(events).hasSize(2).allMatch(SandboxReadyEvent.class::isInstance);
    }

    /**
     * One guard with the submission's catch set, so a listener's failed assertion or linkage error is logged
     * at the ready and the interrupted publications too: the runtime stays UP, and a stopped run still answers its own
     * {@code SandboxException}, not the listener's error. The guard is the host's default publisher's.
     */
    @Test
    void aListenerThatFailsWithAnErrorLeavesTheRuntimeUpAndTheRunsAnswer() {
        runtime = DatumSandbox.builder().runtime(engine).store(Programs.packaged().store()).limits(ProgramLimits.defaults()).hostOptions(HostOptions.defaults())
            .settings(TestSettings.of("endive", true, 0, Duration.ofSeconds(1), 1, Duration.ZERO)).events(DatumEventPublisher.guarded(event -> {
                events.add(event);
                if (event instanceof SandboxReadyEvent) {
                    throw new AssertionError("a listener's invariant");
                }
                throw new NoClassDefFoundError("a listener built against another version");
            })).runLog(RunLog.slf4j()).build();
        runtime.start();
        assertThat(runtime.status().state()).isEqualTo(SandboxStatus.State.UP);
        engine.terminate = Termination.BUDGET;
        assertThatThrownBy(() -> runtime.sandbox().validate(context(), List.of(), false)).isInstanceOf(SandboxException.class);
        assertThat(events).filteredOn(SandboxRunInterruptedEvent.class::isInstance).hasSize(1);
    }

    /**
     * The runtime uses the publisher it is given as given. An application's own
     * publisher that throws at the ready event owns that failure: with fail-fast the start fails naming it, without it the
     * runtime is DOWN with its message.
     */
    @Test
    void anApplicationsOwnPublisherThatThrowsReachesTheStart() {
        DatumEventPublisher outbox = event -> {
            throw new IllegalStateException("outbox down");
        };
        runtime = DatumSandbox.builder().runtime(engine).store(Programs.packaged().store()).limits(ProgramLimits.defaults()).hostOptions(HostOptions.defaults())
            .settings(TestSettings.of("endive", true, 0, Duration.ofSeconds(1), 1, Duration.ZERO)).events(outbox).runLog(RunLog.slf4j()).build();
        assertThatThrownBy(runtime::start).isInstanceOf(IllegalStateException.class).hasMessageContaining("outbox down");
        runtime = DatumSandbox.builder().runtime(engine).store(Programs.packaged().store()).limits(ProgramLimits.defaults()).hostOptions(HostOptions.defaults())
            .settings(TestSettings.of("endive", false, 0, Duration.ofSeconds(1), 1, Duration.ZERO)).events(outbox).runLog(RunLog.slf4j()).build();
        runtime.start();
        assertThat(runtime.status().state()).isEqualTo(SandboxStatus.State.DOWN);
        assertThat(runtime.status().reason()).contains("outbox down");
    }

    @Test
    void aRunThatOutlivesItsCancelCountsAsStuckAndEnoughStuckRunsRefuseNewOnes() throws Exception {
        com.argusvane.datum.sandbox.protocol.Program stubbornProgram = com.argusvane.datum.sandbox.protocol.Program.of(
            com.argusvane.datum.sandbox.protocol.Program.Kind.SANDBOX, new byte[] {9});
        CountDownLatch release = new CountDownLatch(1);
        java.util.concurrent.atomic.AtomicBoolean honour = new java.util.concurrent.atomic.AtomicBoolean();
        // A runtime that does not enforce its budget and ignores the interrupt of a cancel.
        com.argusvane.datum.sandbox.wasi.GuestRuntime stubborn = run -> {
            // The stubborn program is the one whose bytes are {9} (a guest run carries the program's bytes, not the Program).
            if (!java.util.Arrays.equals(run.file(stubbornProgram.kind().fileName()), stubbornProgram.bytes())) {
                return engine.run(run);
            }
            while (true) {
                try {
                    release.await();
                    return com.argusvane.datum.sandbox.wasi.RunOutput.exited(0, new byte[0], null);
                } catch (InterruptedException e) {
                    if (honour.get()) {
                        return new com.argusvane.datum.sandbox.wasi.RunOutput(Termination.INTERRUPTED, -1, null, null, null);
                    }
                }
            }
        };
        // One validation slot and one PDF slot: two stuck runs reach the limit.
        runtime = DatumSandbox.builder().runtime(stubborn).store(Programs.packaged().store()).limits(ProgramLimits.builder().validationConcurrency(1).build())
            .hostOptions(HostOptions.defaults()).settings(TestSettings.of("endive", true, 0, Duration.ofSeconds(1), 1, Duration.ZERO)).events(events::add)
            .runLog(RunLog.slf4j()).build();
        runtime.start();
        runtime.timeouts(Duration.ofMillis(100), Duration.ofMillis(200));
        com.argusvane.datum.sandbox.wasi.Budget budget = ProgramLimits.builder().validationSeconds(1).build().validationBudget();

        // One that ends when cancelled is not stuck; it passed its budget all the same.
        honour.set(true);
        assertThat(runtime.runtime().run(stubbornProgram, "", List.of("qjs"), new byte[0], budget).termination())
            .isEqualTo(Termination.BUDGET);
        assertThat(runtime.stuckRuns()).isZero();

        // Ones that go on after the cancel and its wait are counted (each its own caller's STUCK, a budget answer);
        // slots (1 validation + 1 PDF) of them refuse every new run with server.unavailable (a fault, not a queue).
        honour.set(false);
        for (int i = 1; i <= 2; i++) {
            long started = System.nanoTime();
            assertThat(runtime.runtime().run(stubbornProgram, "", List.of("qjs"), new byte[0], budget).termination())
                .isEqualTo(Termination.STUCK);
            assertThat(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started)).isGreaterThanOrEqualTo(1250);
            assertThat(runtime.stuckRuns()).isEqualTo(i);
        }
        assertThatThrownBy(() -> runtime.runtime().run(stubbornProgram, "", List.of("qjs"), new byte[0], budget))
            .isInstanceOf(com.argusvane.datum.core.ProgramUnavailableException.class)
            .satisfies(e -> assertThat(((com.argusvane.datum.core.DatumException) e).code()).isEqualTo("server.unavailable"));
        assertThat(runtime.status().details()).containsEntry("stuckRuns", 2);

        // Once the guests end, runs start again.
        release.countDown();
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (runtime.stuckRuns() > 0 && System.nanoTime() < deadline) {
            Thread.sleep(10);
        }
        assertThat(runtime.stuckRuns()).isZero();
        assertThat(runtime.runtime().run(stubbornProgram, "", List.of("qjs"), new byte[0], budget).termination())
            .isEqualTo(Termination.EXITED);
    }

    /**
     * A runtime that does not enforce its budget: once {@link #stall} is set every run waits for it, deaf to the
     * interrupt of a cancel unless {@link #honour} is set (then it ends at the interrupt). Unset, it is the test runtime.
     */
    private static final class Stalling implements GuestRuntime {

        private final TestRuntime inner;
        volatile CountDownLatch stall;
        volatile boolean honour;

        Stalling(TestRuntime inner) {
            this.inner = inner;
        }

        @Override
        public RunOutput run(com.argusvane.datum.sandbox.wasi.GuestRun run) {
            CountDownLatch gate = stall;
            if (gate == null) {
                return inner.run(run);
            }
            while (true) {
                try {
                    gate.await();
                    return RunOutput.exited(0, new byte[0], null);
                } catch (InterruptedException e) {
                    if (honour) {
                        return new RunOutput(Termination.INTERRUPTED, -1, null, null, null);
                    }
                }
            }
        }

        @Override
        public EngineInfo engineInfo() {
            return inner.engineInfo();
        }
    }

    /** One validation slot (and one PDF slot), a 1 s validation budget, and a backstop and stop wait tests can sit through. */
    private DatumSandbox stallingRuntime(Stalling stalling) {
        runtime = DatumSandbox.builder().runtime(stalling).store(Programs.packaged().store())
            .limits(ProgramLimits.builder().validationConcurrency(1).validationSeconds(1).build()).hostOptions(HostOptions.defaults())
            .settings(TestSettings.of("endive", true, 0, Duration.ofSeconds(1), 1, Duration.ZERO)).events(events::add)
            .runLog(RunLog.slf4j()).build();
        runtime.start();
        runtime.timeouts(Duration.ofMillis(100), Duration.ofMillis(200));
        return runtime;
    }

    /**
     * A run still going past its budget, the backstop and the stop wait is a budget overrun for its own caller (503
     * {@code wasm.execution_error}, as an ordinary timeout, never the definition's cost), and it still counts as stuck:
     * the observer tells it apart ({@code stuck}), and at the stuck limit a new run is refused as the runtime's fault.
     */
    @Test
    void aStuckRunsOwnCallerIsAnsweredAsABudgetOverrunAndTheRunStillCountsAsStuck() throws Exception {
        Stalling stalling = new Stalling(engine);
        DatumSandbox stuckOne = stallingRuntime(stalling);
        List<String> outcomes = Collections.synchronizedList(new ArrayList<>());
        stuckOne.observer((kind, outcome, elapsed) -> outcomes.add(outcome));
        CountDownLatch release = new CountDownLatch(1);
        stalling.stall = release;
        try {
            for (int i = 1; i <= 2; i++) {
                assertThatThrownBy(() -> stuckOne.sandbox().validate(context(), List.of(), false))
                    .isInstanceOfSatisfying(SandboxException.class, e -> {
                        assertThat(e.reason()).isEqualTo(SandboxException.Reason.BUDGET);
                        assertThat(e.code()).isEqualTo("wasm.execution_error");
                        assertThat(e.httpStatus()).isEqualTo(503);
                        assertThat(e.guestStopped()).as("the host's backstop, not the definition's cost").isFalse();
                        assertThat(e.getMessage()).contains("1 s budget").contains("did not stop").doesNotContain("unavailable");
                    });
                assertThat(stuckOne.stuckRuns()).isEqualTo(i);
            }
            assertThat(outcomes).as("metrics and logs tell it from an ordinary budget stop").containsExactly("stuck", "stuck");
            // One validation slot and one PDF slot: two stuck runs are the limit, and a new run is the runtime's fault.
            assertThatThrownBy(() -> stuckOne.sandbox().validate(context(), List.of(), false))
                .isInstanceOfSatisfying(ProgramUnavailableException.class, e -> {
                    assertThat(e.code()).isEqualTo("server.unavailable");
                    assertThat(e.httpStatus()).isEqualTo(503);
                });
            assertThat(stuckOne.status().details()).containsEntry("stuckRuns", 2);
        } finally {
            stalling.stall = null;
            release.countDown();
        }
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (stuckOne.stuckRuns() > 0 && System.nanoTime() < deadline) {
            Thread.sleep(10);
        }
        assertThat(stuckOne.stuckRuns()).isZero();
        assertThat(stuckOne.sandbox().validate(context(), List.of(), false)).isNotNull();
    }

    /** A run the backstop cancels that then ends within the stop wait passed its budget too: the same budget answer, not stuck. */
    @Test
    void aRunTheBackstopCancelsThatThenEndsIsABudgetOverrunAndNotStuck() {
        Stalling stalling = new Stalling(engine);
        DatumSandbox backstopped = stallingRuntime(stalling);
        List<String> outcomes = Collections.synchronizedList(new ArrayList<>());
        backstopped.observer((kind, outcome, elapsed) -> outcomes.add(outcome));
        CountDownLatch release = new CountDownLatch(1);
        stalling.honour = true;
        stalling.stall = release;
        try {
            assertThatThrownBy(() -> backstopped.sandbox().validate(context(), List.of(), false))
                .isInstanceOfSatisfying(SandboxException.class, e -> {
                    assertThat(e.reason()).isEqualTo(SandboxException.Reason.BUDGET);
                    assertThat(e.code()).isEqualTo("wasm.execution_error");
                    assertThat(e.guestStopped()).isFalse();
                    assertThat(e.getMessage()).contains("1 s budget").doesNotContain("did not stop");
                });
        } finally {
            stalling.stall = null;
            release.countDown();
        }
        assertThat(backstopped.stuckRuns()).isZero();
        assertThat(outcomes).containsExactly("budget");
    }

    /** The caller's own thread interrupted while its run is going: the host cut it short, 503 server.unavailable. */
    @Test
    void aCallerInterruptedWhileItsRunIsGoingIsServerUnavailable() throws Exception {
        DatumSandbox started = runtime(true, 0, ProgramLimits.defaults(), Duration.ofSeconds(1));
        started.start();
        engine.hold = new CountDownLatch(1);
        engine.holding = new CountDownLatch(1);
        java.util.concurrent.atomic.AtomicReference<Throwable> failure = new java.util.concurrent.atomic.AtomicReference<>();
        Thread caller = new Thread(() -> {
            try {
                started.sandbox().validate(context(), List.of(), false);
            } catch (Throwable e) {
                failure.set(e);
            }
        });
        caller.start();
        try {
            assertThat(engine.holding.await(5, TimeUnit.SECONDS)).isTrue();
            caller.interrupt();
            caller.join(5000);
            assertThat(caller.isAlive()).isFalse();
        } finally {
            engine.hold.countDown();
        }
        assertThat(failure.get()).isInstanceOfSatisfying(SandboxException.class, e -> {
            assertThat(e.reason()).isEqualTo(SandboxException.Reason.INTERRUPTED);
            assertThat(e.code()).isEqualTo("server.unavailable");
            assertThat(e.httpStatus()).isEqualTo(503);
        });
    }

    @Test
    void anOverrideIsReadAgainByARecheck() {
        Programs programs = Programs.packaged();
        byte[][] current = {"/* one */".getBytes()};
        // A handle that reads the bytes afresh on every open, as a file override does (the Spring binding's
        // Resource adapter is tested in datum-spring-web's SpringResourcesTest).
        com.argusvane.datum.core.io.ResourceHandle override = new com.argusvane.datum.core.io.ResourceHandle() {
            @Override
            public String description() {
                return "test override";
            }

            @Override
            public boolean exists() {
                return true;
            }

            @Override
            public java.io.InputStream open() {
                return new java.io.ByteArrayInputStream(current[0]);
            }
        };
        runtime = DatumSandbox.builder().runtime(engine).store(new ProgramStore(programs.lookup(), override, null)).limits(ProgramLimits.defaults()).hostOptions(HostOptions.defaults())
            .settings(TestSettings.of("endive", true, 0, Duration.ofSeconds(1), 1, Duration.ZERO)).events(events::add).runLog(RunLog.slf4j()).build();
        runtime.start();
        String first = runtime.sandbox().program().sha256();
        current[0] = "/* two */".getBytes();
        runtime.recheck();
        assertThat(runtime.sandbox().program().sha256()).isNotEqualTo(first);
        assertThat(engine.sandboxProbes()).isEqualTo(2);
    }

    // ------------------------------------------------------------------------------------------ startup budget

    private DatumSandbox runtimeWithStartupBudget(Duration startupBudget) {
        runtime = DatumSandbox.builder().runtime(engine).store(Programs.packaged().store()).limits(ProgramLimits.defaults()).hostOptions(HostOptions.defaults())
            .settings(TestSettings.of("endive", true, 2, Duration.ofSeconds(1), 1, Duration.ZERO, startupBudget)).events(events::add).runLog(RunLog.slf4j()).build();
        return runtime;
    }

    @Test
    void aSlowProbeWithinTheStartupBudgetStartsAndRequestsKeepTheirOwnBudget() {
        // An engine that needs 20 s for any run: over the 5 s validation and the 15 s PDF budgets, within 30 s.
        engine.costSeconds = 20;
        DatumSandbox slow = runtimeWithStartupBudget(SandboxSettings.DEFAULT_STARTUP_BUDGET);
        slow.start();
        assertThat(slow.status().state()).isEqualTo(SandboxStatus.State.UP);
        // Every proof run (two probes, two smokes) was given the startup budget...
        assertThat(engine.budgets).hasSize(4).allSatisfy(budget -> assertThat(budget.seconds()).isEqualTo(30));
        // ...and a request is held to the per-run budget again: the slow engine is refused at 5 s.
        engine.budgets.clear();
        assertThatThrownBy(() -> slow.sandbox().validate(context(), List.of(), true)).isInstanceOf(SandboxException.class);
        assertThat(engine.budgets).singleElement().satisfies(budget -> assertThat(budget.seconds()).isEqualTo(ProgramLimits.defaults().validationBudget().seconds()));
    }

    @Test
    void theSameSlowProbeBeyondAShortStartupBudgetRefusesTheStart() {
        engine.costSeconds = 20;
        DatumSandbox slow = runtimeWithStartupBudget(Duration.ofSeconds(2));
        assertThatThrownBy(slow::start).isInstanceOf(IllegalStateException.class);
        assertThat(slow.status().state()).isEqualTo(SandboxStatus.State.DOWN);
    }

    @Test
    void theStartupBudgetIsClampedToOneSecondThroughFiveMinutesInWholeSeconds() {
        assertThat(SandboxSettings.clampStartupBudget(null)).isEqualTo(Duration.ofSeconds(30));
        assertThat(SandboxSettings.clampStartupBudget(Duration.ZERO)).isEqualTo(Duration.ofSeconds(1));
        assertThat(SandboxSettings.clampStartupBudget(Duration.ofMillis(900))).isEqualTo(Duration.ofSeconds(1));
        assertThat(SandboxSettings.clampStartupBudget(Duration.ofSeconds(-5))).isEqualTo(Duration.ofSeconds(1));
        assertThat(SandboxSettings.clampStartupBudget(Duration.ofMillis(45_500))).isEqualTo(Duration.ofSeconds(45));
        assertThat(SandboxSettings.clampStartupBudget(Duration.ofHours(2))).isEqualTo(Duration.ofMinutes(5));
        assertThat(TestSettings.of("endive", true, 1, Duration.ZERO, 1, Duration.ZERO).lifecycle().startupBudget()).isEqualTo(Duration.ofSeconds(30));
    }

    /** An engine that counts its stray runs ({@code GuestRuntime.strayRuns()}), as Endive's harness does. */
    public static final class Straying implements com.argusvane.datum.sandbox.wasi.GuestRuntime {

        @Override
        public com.argusvane.datum.sandbox.wasi.RunOutput run(com.argusvane.datum.sandbox.wasi.GuestRun run) {
            throw new UnsupportedOperationException();
        }

        @Override
        public int strayRuns() {
            return 3;
        }
    }

    @Test
    void strayRunsOfTheEngineAreReadWhenItCountsThemAndLeftOutWhenItDoesNot() {
        SandboxSettings settings = TestSettings.of("endive", true, 0, Duration.ofSeconds(1), 1, Duration.ZERO);
        assertThat(DatumSandbox.builder().runtime(new Straying()).store(Programs.packaged().store()).limits(ProgramLimits.defaults()).hostOptions(HostOptions.defaults()).settings(settings)
            .events(events::add).runLog(RunLog.slf4j()).build().status().strayRuns()).isEqualTo(3);
        assertThat(DatumSandbox.builder().runtime(new TestRuntime()).store(Programs.packaged().store()).limits(ProgramLimits.defaults()).hostOptions(HostOptions.defaults()).settings(settings)
            .events(events::add).runLog(RunLog.slf4j()).build().status().strayRuns()).isEqualTo(-1);
        assertThat(DatumSandbox.builder().withoutRuntime().store(Programs.packaged().store()).limits(ProgramLimits.defaults()).hostOptions(HostOptions.defaults()).settings(settings)
            .events(events::add).runLog(RunLog.slf4j()).build().status().strayRuns()).isEqualTo(-1);
        com.argusvane.datum.sandbox.wasi.GuestRuntime throwing = new com.argusvane.datum.sandbox.wasi.GuestRuntime() {
            @Override
            public com.argusvane.datum.sandbox.wasi.RunOutput run(com.argusvane.datum.sandbox.wasi.GuestRun run) {
                throw new UnsupportedOperationException();
            }

            @Override
            public int strayRuns() {
                throw new IllegalStateException("cannot count");
            }
        };
        assertThat(DatumSandbox.builder().runtime(throwing).store(Programs.packaged().store()).limits(ProgramLimits.defaults()).hostOptions(HostOptions.defaults()).settings(settings)
            .events(events::add).runLog(RunLog.slf4j()).build().status().strayRuns()).as("a count that throws never fails health").isEqualTo(-1);
        EngineInfo endive = new EngineInfo("endive", "1.1.0", "jffi", "");
        SandboxStatus withStrays = new SandboxStatus(SandboxStatus.State.UP, null, endive, true, "1.0.0", null, null, 1, 1, 1, 1, 0, 5, 2, 3);
        assertThat(withStrays.details()).containsEntry("stuckRuns", 2).containsEntry("strayRuns", 3).doesNotContainKey("engineNotes");
        SandboxStatus without = new SandboxStatus(SandboxStatus.State.UP, null, EngineInfo.unreported("x"), true, null, null, null, 1, 1, 1, 1, 0, 5, 0, -1);
        assertThat(without.details()).containsEntry("stuckRuns", 0).doesNotContainKey("strayRuns").containsEntry("engineMode", "unknown");
    }

    @Test
    void theEngineIsWhatTheRuntimeReportsNeverReadByReflection() {
        SandboxSettings settings = TestSettings.of("endive", true, 0, Duration.ofSeconds(1), 1, Duration.ZERO);
        // A runtime with a public nativeProvider() and no engineInfo(): nothing reads the method.
        com.argusvane.datum.sandbox.wasi.GuestRuntime unreported = new com.argusvane.datum.sandbox.wasi.GuestRuntime() {
            @Override
            public com.argusvane.datum.sandbox.wasi.RunOutput run(com.argusvane.datum.sandbox.wasi.GuestRun run) {
                throw new UnsupportedOperationException();
            }

            @SuppressWarnings("unused")
            public String nativeProvider() {
                return "bytecode";
            }
        };
        EngineInfo described = DatumSandbox.builder().runtime(unreported).store(Programs.packaged().store()).limits(ProgramLimits.defaults()).hostOptions(HostOptions.defaults())
            .settings(settings).events(events::add).runLog(RunLog.slf4j()).build().engineInfo();
        assertThat(described.id()).isEqualTo(unreported.getClass().getName());
        assertThat(described.mode()).isEqualTo(EngineInfo.UNKNOWN);
        EngineInfo none = DatumSandbox.builder().withoutRuntime().store(Programs.packaged().store()).limits(ProgramLimits.defaults()).hostOptions(HostOptions.defaults()).settings(settings)
            .events(events::add).runLog(RunLog.slf4j()).build().engineInfo();
        assertThat(none.id()).isEqualTo("endive");
        assertThat(none.mode()).isEqualTo("none");
        // No engine is the null delegate, not the mode: the status and the shared predicate agree.
        assertThat(DatumSandbox.builder().withoutRuntime().store(Programs.packaged().store()).limits(ProgramLimits.defaults()).hostOptions(HostOptions.defaults()).settings(settings)
            .events(events::add).runLog(RunLog.slf4j()).build().status().details()).as("no engine runs no PDF program").containsEntry("pdfCapable", false);
        assertThat(ProgramRunner.canRunPdf(none)).as("the shared predicate reads bytecode only").isTrue();
    }

    /** A run the engine cannot start answers the protocol's 503 server.unavailable, not an IllegalState. */
    @Test
    void anEngineThatCannotStartARunIsAServerUnavailableAnswer() {
        DatumSandbox started = runtime(true);
        started.start();
        engine.failValidations = new com.argusvane.datum.sandbox.wasi.GuestUnavailableException("The runtime is refusing runs: 2 stopped runs have not ended yet.");
        assertThatThrownBy(() -> started.sandbox().validate(context(), List.of(), false))
            .isInstanceOfSatisfying(ProgramUnavailableException.class, e -> {
                assertThat(e.httpStatus()).isEqualTo(503);
                assertThat(e.code()).isEqualTo("server.unavailable");
                assertThat(e.getMessage()).contains("stopped runs");
            });
    }

    /** A report that throws cannot show the PDF program is runnable, so health says no and the PDF program is not built. */
    @Test
    void anEngineWhoseReportFailsIsNotPdfCapable() {
        engine.mode = "jffi";
        GuestRuntime failing = new GuestRuntime() {
            @Override
            public RunOutput run(com.argusvane.datum.sandbox.wasi.GuestRun run) {
                return engine.run(run);
            }

            @Override
            public EngineInfo engineInfo() {
                throw new IllegalStateException("cannot say");
            }
        };
        DatumSandbox started = DatumSandbox.builder().runtime(failing).store(Programs.packaged().store()).limits(ProgramLimits.defaults()).hostOptions(HostOptions.defaults())
            .settings(TestSettings.of("endive", true, 0, Duration.ofSeconds(1), 1, Duration.ZERO)).events(events::add).runLog(RunLog.slf4j()).build();
        runtime = started;
        started.start();
        assertThat(started.status().details()).containsEntry("pdfCapable", false);
        assertThatThrownBy(started::pdfProgram).isInstanceOf(ProgramUnavailableException.class);
        assertThat(started.sandbox()).isNotNull();
    }

    // ---- the builder

    @Test
    void theBuilderMakesARuntimeThatStartsLikeTheDeprecatedConstructors() {
        runtime = DatumSandbox.builder().runtime(engine).store(Programs.packaged().store()).limits(ProgramLimits.defaults())
            .settings(TestSettings.of("endive", true, 2, Duration.ofSeconds(1), 1, Duration.ZERO)).events(events::add).build();
        runtime.start();

        assertThat(runtime.isRunning()).isTrue();
        assertThat(engine.sandboxProbes()).isEqualTo(1);
        assertThat(engine.smokes()).isEqualTo(2);
        assertThat(events).singleElement().isInstanceOf(SandboxReadyEvent.class);
    }

    /** The settings are the only input; with no runtime the engine is selected by the settings' id, and none is a choice. */
    @Test
    void theBuilderTakesOnlyTheSettingsAndSelectsTheEngineByItsId() {
        // This module has no engine on its class path, so the default build says which id it looked for and what is missing.
        assertThatThrownBy(() -> DatumSandbox.builder().build()).isInstanceOf(EngineSelectionException.class)
            .hasMessageContaining("\"endive\"").hasMessageContaining("engines found");
        assertThatThrownBy(() -> DatumSandbox.builder().settings(SandboxSettings.builder().engine("mine").build()).build())
            .isInstanceOf(EngineSelectionException.class).hasMessageContaining("\"mine\"");
        // No engine at all: a sandbox that stays down, on the settings' own limits and programs.
        DatumSandbox none = DatumSandbox.builder().withoutRuntime().settings(TestSettings.of("endive", false, 0, Duration.ofSeconds(1), 1, Duration.ZERO))
            .events(events::add).build();
        assertThat(none.isRunning()).isFalse();
        assertThat(none.limits()).isEqualTo(none.settings().limits(null));
        assertThat(none.explain().get("datum.runtime.engine").value()).isEqualTo("endive");
        assertThatThrownBy(() -> DatumSandbox.builder().runtime(null)).isInstanceOf(NullPointerException.class);
        assertThatThrownBy(() -> DatumSandbox.builder().settings(null)).isInstanceOf(NullPointerException.class);
    }

    /** close() is stop(): the pool is gone, the runtime a caller handed in is not closed, and closing twice is harmless. */
    @Test
    void closeStopsTheSandboxAndLeavesACallersRuntimeOpen() {
        AtomicInteger closes = new AtomicInteger();
        class Closeable implements GuestRuntime, AutoCloseable {
            @Override
            public RunOutput run(com.argusvane.datum.sandbox.wasi.GuestRun run) {
                return engine.run(run);
            }

            @Override
            public EngineInfo engineInfo() {
                return engine.engineInfo();
            }

            @Override
            public void close() {
                closes.incrementAndGet();
            }
        }
        DatumSandbox sandbox = DatumSandbox.builder().runtime(new Closeable()).settings(TestSettings.of("endive", true, 1, Duration.ofSeconds(1), 1, Duration.ZERO))
            .events(events::add).build();
        sandbox.start();
        assertThat(sandbox.isRunning()).isTrue();
        sandbox.close();
        sandbox.close();
        assertThat(sandbox.isRunning()).isFalse();
        assertThat(sandbox.status().state()).isEqualTo(SandboxStatus.State.STOPPED);
        assertThat(closes).as("an engine the caller made is the caller's to close").hasValue(0);
    }
}
