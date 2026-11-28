package com.argusvane.datum.sandbox.endive;

import com.argusvane.datum.sandbox.wasi.GuestRuntime;
import com.argusvane.datum.sandbox.tck.GoldenVerdictsContract;
import org.junit.jupiter.api.AfterAll;

/**
 * The real program on Endive answers exactly what the security suite pins for ABI 1.0: datum-sandbox-tck's
 * {@link GoldenVerdictsContract} (the golden case's outcome bytes and the six control verdicts).
 */
class GoldenIT implements GoldenVerdictsContract {

    private static final EndiveGuestRuntime RUNTIME = new EndiveGuestRuntime();

    @AfterAll
    static void stop() {
        RUNTIME.close();
    }

    @Override
    public GuestRuntime runtime() {
        return RUNTIME;
    }
}
