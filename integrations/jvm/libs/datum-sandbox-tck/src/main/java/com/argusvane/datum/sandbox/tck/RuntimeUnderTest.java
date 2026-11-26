package com.argusvane.datum.sandbox.tck;

import com.argusvane.datum.sandbox.wasi.EngineSettings;
import com.argusvane.datum.sandbox.wasi.GuestRuntime;
import java.time.Duration;
import java.util.Optional;
import java.util.concurrent.CountDownLatch;

/**
 * What every contract asks of the engine under test.
 *
 * <p>{@link #runtime()} is the runtime the class's tests share: create it once (a static field is simplest; the
 * contracts' {@code @BeforeAll} warm-up runs before the class's own {@code @BeforeAll}, so create it no later than the
 * first call) and close it in the class's {@code @AfterAll}.
 */
public interface RuntimeUnderTest {

    /** The runtime under test, shared by the class's tests. */
    GuestRuntime runtime();

    /**
     * The grace the runtime gives a stopped run before its output is read: a stop at the budget must answer within the
     * budget plus this.
     */
    default Duration stopGrace() {
        return EngineSettings.DEFAULT_STOP_GRACE;
    }

    /**
     * A runtime of its own with this stop grace and stray bound, whose started runs do not end, even when stopped, until
     * {@code hold} is counted down (an engine path that does not answer interrupts); empty skips the stray tests, here and
     * in {@link SandboxHardeningContract}. The contract closes it.
     */
    default Optional<GuestRuntime> holdingRuntime(Duration stopGrace, int maxStrays, CountDownLatch hold) {
        return Optional.empty();
    }
}
