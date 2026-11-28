package com.argusvane.datum.sandbox.endive;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.sandbox.wasi.EngineInfo;
import com.argusvane.datum.sandbox.wasi.Budget;
import com.argusvane.datum.sandbox.protocol.Program;
import com.argusvane.datum.sandbox.protocol.ProgramRunner;
import com.argusvane.datum.sandbox.wasi.GuestUnavailableException;
import com.argusvane.datum.sandbox.wasi.GuestRuntime;
import com.argusvane.datum.sandbox.wasi.RunOutput;
import com.argusvane.datum.sandbox.wasi.Termination;
import com.argusvane.datum.sandbox.tck.RuntimeContract;
import com.argusvane.datum.sandbox.tck.RuntimeTckAssets;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;

/**
 * The runtime's own promises on Endive: datum-sandbox-tck's {@link RuntimeContract} (the private {@code /app}, confinement,
 * every way a run ends with the started marker kept, caps, cancellation alone and together, shutdown, the heap slope),
 * plus what only Endive has: the runner this execution expects, the native-memory bookkeeping when a stop or a failure
 * comes during {@code build()}, the stray bound through the test hook, and the module's own minimum memory.
 */
class EndiveRuntimeIT implements RuntimeContract {

    private static final EndiveGuestRuntime RUNTIME = new EndiveGuestRuntime();

    private final Program program = RuntimeTckAssets.sandboxProgram();

    @AfterAll
    static void stop() {
        RUNTIME.close();
    }

    @Override
    public GuestRuntime runtime() {
        return RUNTIME;
    }

    @Override
    public GuestRuntime newRuntime() {
        return new EndiveGuestRuntime();
    }

    @Override
    public Duration stopGrace() {
        return EndiveGuestRuntime.STOP_GRACE;
    }

    /**
     * Unbounded JavaScript recursion reaches the C stack's floor long before Endive's call stack runs out, so it ends as the
     * stack guard's trap ({@link StackGuard#OVERRUN}).
     */
    @Override
    public void checkStackTrapMessage(String trapMessage) {
        assertThat(trapMessage).startsWith(StackGuard.OVERRUN);
    }

    private static Budget budget(int seconds, int mib) {
        return new Budget(seconds, (long) mib << 20, Budget.STDOUT_LIMIT, Budget.STDERR_LIMIT);
    }

    private RunOutput raw(String script, Budget budget) {
        return RUNTIME.run(ProgramRunner.guestRun(program, script, RAW, new byte[0], budget));
    }

    private static String out(RunOutput output) {
        return new String(output.stdout(), StandardCharsets.UTF_8);
    }

    @Test
    void theRunnerIsTheOneThisExecutionExpects() {
        String expected = System.getProperty("datum.expectedProvider", "jffi");
        assertThat(RUNTIME.nativeProvider()).isEqualTo(expected);
        assertThat(RUNTIME.info().providerClass()).isEqualTo(Runner.valueOf(expected.toUpperCase(java.util.Locale.ROOT)).providerClass());
        EngineInfo engine = RUNTIME.engineInfo();
        assertThat(engine.id()).isEqualTo("endive");
        assertThat(engine.mode()).as("the engine's mode is the runner").isEqualTo(expected);
        assertThat(engine.version()).isEqualTo(RUNTIME.info().endiveVersion());
        assertThat(engine.isBytecode()).as("a native runner is not bytecode, so the lifecycle runs the PDF program").isFalse();
        assertThat(engine.notes()).contains(RUNTIME.info().qjsVersion()).contains(expected);
        System.out.printf("[datum-sandbox-endive] Java %d, runner %s (%s), QuickJS %s, %s%n", Runtime.version().feature(),
            RUNTIME.nativeProvider(), RUNTIME.info().providerClass(), RUNTIME.info().qjsVersion(), RUNTIME.info().selection());
    }

    /**
     * A run stopped while its instance is still being built is never interrupted there: the thread finishes the
     * set-up and closes the instance, so its linear memory is unmapped. The leak this guards against: twelve parallel runs with a
     * 1 s budget, stopped in set-up, left a whole memory limit of address space each.
     */
    @Test
    void runsStoppedDuringSetUpLeaveNoMemoryBehind() throws Exception {
        int runs = 12;
        ExecutorService pool = Executors.newFixedThreadPool(runs);
        try {
            List<Future<RunOutput>> futures = new ArrayList<>();
            for (int i = 0; i < runs; i++) {
                futures.add(pool.submit(() -> raw("print('@@started@@'); for (;;) {}", budget(1, 1024))));
            }
            int beforeStart = 0;
            for (Future<RunOutput> future : futures) {
                RunOutput output = future.get();
                assertThat(output.termination()).isEqualTo(Termination.BUDGET);
                if (output.stdoutLength() == 0) {
                    beforeStart++;
                }
            }
            assertThat(RUNTIME.unclosedMemories()).as("every memory made was handed to a close").isZero();
            assertThat(RUNTIME.strayRuns()).isZero();
            System.out.printf("[datum-sandbox-endive] %d of %d runs were stopped before their first line%n", beforeStart, runs);
        } finally {
            pool.shutdownNow();
        }
        assertThat(raw("print('again');", budget(30, 32)).exitCode()).as("the next run is fine").isZero();
    }

    /**
     * A stop that comes while the instance is being built does not interrupt the set-up (the leak: the
     * interrupt made build() fail after it had mapped the linear memory, with no instance to close). The hook holds the
     * set-up past the 1 s budget and records any interrupt; the thread then finishes build(), sees the run abandoned
     * and closes the instance without starting it.
     */
    @Test
    void aStopDuringSetUpDoesNotInterruptItAndClosesTheInstance() throws Exception {
        EndiveGuestRuntime setUp = new EndiveGuestRuntime();
        CountDownLatch release = new CountDownLatch(1);
        AtomicReference<Boolean> interrupted = new AtomicReference<>(false);
        try {
            setUp.beforeBuildForTests = () -> {
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
            Thread releaser = new Thread(() -> {
                try {
                    Thread.sleep(2000);
                } catch (InterruptedException ignored) {
                    // released at once
                }
                release.countDown();
            });
            releaser.start();
            RunOutput output = setUp.run(ProgramRunner.guestRun(program, "print('@@started@@'); for (;;) {}", RAW, new byte[0], budget(1, 256)));
            releaser.join();
            assertThat(output.termination()).isEqualTo(Termination.BUDGET);
            assertThat(output.stdoutLength()).as("never started").isZero();
            assertThat(interrupted.get()).as("no interrupt reached the set-up").isFalse();
            assertThat(setUp.unclosedMemories()).isZero();
            assertThat(setUp.closedAfterFailedBuild()).as("build() was not made to fail").isZero();
            assertThat(setUp.strayRuns()).isZero();
            setUp.beforeBuildForTests = null;
            assertThat(setUp.run(ProgramRunner.guestRun(program, "print(1);", RAW, new byte[0], budget(30, 32))).exitCode()).isZero();
        } finally {
            release.countDown();
            setUp.close();
        }
    }

    /**
     * Should build() fail after it made the linear memory (here an interrupt from elsewhere lands in the runner's
     * set-up, as has been seen), that memory is closed before the failure goes on, and the run is the host's stop.
     */
    @Test
    void aBuildThatFailsClosesTheMemoryItMade() {
        EndiveGuestRuntime failing = new EndiveGuestRuntime();
        try {
            failing.beforeBuildForTests = () -> Thread.currentThread().interrupt();
            RunOutput output = failing.run(ProgramRunner.guestRun(program, "print('@@started@@');", RAW, new byte[0], budget(30, 256)));
            assertThat(output.termination()).isEqualTo(Termination.INTERRUPTED);
            // Endive 1.1.0's build() made the linear memory first and failed after (one memory closed here); 1.2.0's
            // notices the interrupt before it makes the memory, so there is nothing to close. Either way none is left.
            assertThat(failing.closedAfterFailedBuild()).as("a memory made before build() failed is closed").isBetween(0, 1);
            assertThat(failing.unclosedMemories()).isZero();
            failing.beforeBuildForTests = null;
            assertThat(failing.run(ProgramRunner.guestRun(program, "print(1);", RAW, new byte[0], budget(30, 32))).exitCode()).as("the pool thread is clean").isZero();
        } finally {
            failing.close();
        }
    }

    /**
     * Closing the runtime stops every run in flight, one still in set-up included, as INTERRUPTED and leaves no memory
     * behind; close() never interrupts a thread inside build().
     */
    @Test
    void closeStopsRunsInFlightAndLeavesNoMemoryBehind() throws Exception {
        EndiveGuestRuntime closing = new EndiveGuestRuntime();
        ExecutorService pool = Executors.newFixedThreadPool(4);
        try {
            List<Future<RunOutput>> futures = new ArrayList<>();
            for (int i = 0; i < 4; i++) {
                futures.add(pool.submit(() -> closing.run(ProgramRunner.guestRun(program, "print('@@started@@'); for (;;) {}", RAW, new byte[0], budget(60, 64)))));
            }
            Thread.sleep(150);
            closing.close();
            for (Future<RunOutput> future : futures) {
                assertThat(future.get(30, TimeUnit.SECONDS).termination()).isEqualTo(Termination.INTERRUPTED);
            }
            assertThat(closing.unclosedMemories()).isZero();
        } finally {
            pool.shutdownNow();
            closing.close();
        }
    }

    /**
     * A stopped run whose thread outlives the grace no longer holds its caller's slot, so the runtime counts it and,
     * at its limit, refuses new runs until it ends. The test hook makes the thread ignore
     * interrupts before it closes its instance, as an engine path that does not answer them would.
     */
    @Test
    void strayRunsPastTheirGraceRefuseNewRunsUntilTheyEnd() throws Exception {
        EndiveGuestRuntime strict = new EndiveGuestRuntime(ProviderSelector.select(), Duration.ofMillis(200), 1);
        CountDownLatch hold = new CountDownLatch(1);
        try {
            strict.holdBeforeCloseForTests = hold;
            RunOutput stopped = strict.run(ProgramRunner.guestRun(program, "print('@@started@@'); for (;;) {}", RAW, new byte[0], budget(5, 32)));
            assertThat(stopped.termination()).isEqualTo(Termination.BUDGET);
            assertThat(out(stopped)).as("it was stopped inside _start, where the hook holds it").isEqualTo("@@started@@\n");
            assertThat(strict.strayRuns()).isEqualTo(1);
            assertThatThrownBy(() -> strict.run(ProgramRunner.guestRun(program, "print(1);", RAW, new byte[0], budget(30, 32))))
                .isInstanceOf(GuestUnavailableException.class)
                .hasMessageContaining("stopped runs");
            strict.holdBeforeCloseForTests = null;
            hold.countDown();
            long deadline = System.nanoTime() + 10_000_000_000L;
            while (strict.strayRuns() > 0 && System.nanoTime() < deadline) {
                Thread.sleep(20);
            }
            assertThat(strict.strayRuns()).isZero();
            assertThat(strict.unclosedMemories()).isZero();
            assertThat(strict.run(ProgramRunner.guestRun(program, "print(1);", RAW, new byte[0], budget(30, 32))).exitCode()).isZero();
        } finally {
            hold.countDown();
            strict.close();
        }
    }

    @Test
    void aBudgetBelowTheModulesOwnMemoryIsRefused() {
        Budget tiny = new Budget(5, EndiveGuestRuntime.minimumMemoryBytes() - 1, Budget.STDOUT_LIMIT, Budget.STDERR_LIMIT);
        assertThatThrownBy(() -> raw("print(1);", tiny)).isInstanceOf(IllegalArgumentException.class);
    }
}
