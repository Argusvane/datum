package com.argusvane.datum.sandbox.endive;

import com.argusvane.datum.sandbox.tck.WasiHardeningContract;
import com.argusvane.datum.sandbox.wasi.GuestRuntime;
import com.argusvane.datum.sandbox.wasi.GuestRuntimeProvider;
import java.time.Duration;
import java.util.Optional;
import java.util.concurrent.CountDownLatch;
import org.junit.jupiter.api.AfterAll;

/**
 * The hardened WASI run on Endive, through the wasi layer alone: datum-sandbox-tck's {@link WasiHardeningContract} (the fresh
 * read-only /app of the run's files, no environment or network, the budget, the caps that stop at once, every byte kept,
 * stops in set-up, every instance closed, the stray bound, the floor at creation), with no Datum program.
 */
class WasiHardeningIT implements WasiHardeningContract {

    private static final EndiveGuestRuntime RUNTIME = new EndiveGuestRuntime();

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

    @Override
    public Optional<GuestRuntimeProvider> provider() {
        return Optional.of(new EndiveRuntimeProvider());
    }

    /** Endive's test hook: a started run's thread waits for the latch, ignoring interrupts, before it closes its instance. */
    @Override
    public Optional<GuestRuntime> holdingRuntime(Duration stopGrace, int maxStrays, CountDownLatch hold) {
        EndiveGuestRuntime holding = new EndiveGuestRuntime(ProviderSelector.select(), stopGrace, maxStrays);
        holding.holdBeforeCloseForTests = hold;
        return Optional.of(holding);
    }

    /** The native memories Endive made for instances and has not closed (0 on the bytecode path, whose memory is on the heap). */
    @Override
    public long openInstances(GuestRuntime runtime) {
        return ((EndiveGuestRuntime) runtime).unclosedMemories();
    }
}
