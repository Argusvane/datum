package com.argusvane.datum.sandbox.endive;

import com.argusvane.datum.sandbox.wasi.GuestRuntime;
import com.argusvane.datum.sandbox.tck.SandboxHardeningContract;
import java.time.Duration;
import java.util.Optional;
import java.util.concurrent.CountDownLatch;
import org.junit.jupiter.api.AfterAll;

/**
 * The sandbox hardening on Endive: datum-sandbox-tck's {@link SandboxHardeningContract} (the ABI gate, forging, rebinding,
 * stray bytes, thrown words, the output cap, the depth guard, the loop, memory and recursion stops, the smoke run).
 */
class SandboxHardeningIT implements SandboxHardeningContract {

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
    public Duration stopGrace() {
        return EndiveGuestRuntime.STOP_GRACE;
    }

    /** Endive's test hook: a started run's thread waits for the latch, ignoring interrupts, before it closes its instance. */
    @Override
    public Optional<GuestRuntime> holdingRuntime(Duration stopGrace, int maxStrays, CountDownLatch hold) {
        EndiveGuestRuntime holding = new EndiveGuestRuntime(ProviderSelector.select(), stopGrace, maxStrays);
        holding.holdBeforeCloseForTests = hold;
        return Optional.of(holding);
    }
}
