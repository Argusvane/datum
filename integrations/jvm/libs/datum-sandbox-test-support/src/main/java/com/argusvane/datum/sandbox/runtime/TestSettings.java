package com.argusvane.datum.sandbox.runtime;

import java.time.Duration;

/**
 * The few settings the runtime tests vary, in the order the runtime's own settings record once took them, so a test says what
 * it means in one line: {@code of("endive", failFast, warmUps, shutdownGrace, pdfSlots, pdfWait)}. Everything else is the default.
 */
public final class TestSettings {

    private TestSettings() {
    }

    /** The engine word, fail-fast, warm-ups, shutdown grace, PDF slots and PDF wait; the rest default. */
    public static SandboxSettings of(String engine, boolean failFast, int warmUps, Duration shutdownGrace, int pdfSlots, Duration pdfWait) {
        return builder(engine, failFast, warmUps, shutdownGrace, pdfSlots, pdfWait).build();
    }

    /** As {@link #of(String, boolean, int, Duration, int, Duration)} with the startup budget. */
    public static SandboxSettings of(String engine, boolean failFast, int warmUps, Duration shutdownGrace, int pdfSlots, Duration pdfWait,
                                     Duration startupBudget) {
        return builder(engine, failFast, warmUps, shutdownGrace, pdfSlots, pdfWait).startupBudget(startupBudget).build();
    }

    /** As above, with the startup budget and whether an engine that runs as bytecode may start. */
    public static SandboxSettings of(String engine, boolean failFast, int warmUps, Duration shutdownGrace, int pdfSlots, Duration pdfWait,
                                     Duration startupBudget, boolean allowBytecode) {
        return builder(engine, failFast, warmUps, shutdownGrace, pdfSlots, pdfWait).startupBudget(startupBudget).allowBytecode(allowBytecode).build();
    }

    /** The builder behind {@code of}, for a test that sets one more key. */
    public static SandboxSettings.Builder builder(String engine, boolean failFast, int warmUps, Duration shutdownGrace, int pdfSlots, Duration pdfWait) {
        return SandboxSettings.builder().engine(engine).failFast(failFast).warmUpRuns(warmUps).shutdownGrace(shutdownGrace)
            .pdfConcurrency(pdfSlots).pdfWait(pdfWait);
    }
}
