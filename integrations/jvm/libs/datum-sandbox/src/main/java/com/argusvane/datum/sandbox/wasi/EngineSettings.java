package com.argusvane.datum.sandbox.wasi;

import java.time.Duration;
import java.util.Objects;

/**
 * How the run harness treats a run it stopped, the settings an engine is created with besides its memory limits
 * ({@link GuestRuntimeProvider#create}, {@link EngineLimits}).
 *
 * @param stopGrace how long a stopped run's thread is given to end and close its instance before its output is read as
 *     it stands; the run's "started" marker is in that output, so the grace is what lets a classifier tell a stop the
 *     guest ran into from a runtime that never started
 * @param maxStrays how many stopped runs may outlive the grace before new runs are refused: the caller's slots no longer
 *     bound a run whose caller was answered, so this bounds the live instances (and their memory) instead
 */
public record EngineSettings(Duration stopGrace, int maxStrays) {
    // Copies: one component changed, the rest kept; the canonical constructor
    // checks the result, so a copy cannot hold what a new value could not. Replaces a positional constructor call that
    // breaks whenever a component is added.

    /** A copy with {@code stopGrace} replaced and every other component kept. */
    public EngineSettings withStopGrace(Duration value) {
        return new EngineSettings(value, maxStrays);
    }

    /** A copy with {@code maxStrays} replaced and every other component kept. */
    public EngineSettings withMaxStrays(int value) {
        return new EngineSettings(stopGrace, value);
    }

    /** The default {@link #stopGrace()}: an interrupted native or bytecode machine stops within a fraction of a second. */
    public static final Duration DEFAULT_STOP_GRACE = Duration.ofSeconds(5);

    public EngineSettings {
        Objects.requireNonNull(stopGrace, "stopGrace");
        if (stopGrace.isNegative()) {
            throw new IllegalArgumentException("The stop grace is not negative: " + stopGrace);
        }
        if (maxStrays < 1) {
            throw new IllegalArgumentException("maxStrays must be at least 1");
        }
    }

    /** The default {@link #maxStrays()}: the default slot count, one per CPU this JVM may use, at least two. */
    public static int defaultMaxStrays() {
        return Math.max(2, Runtime.getRuntime().availableProcessors());
    }

    /** A five-second grace and one stray per CPU (at least two). */
    public static EngineSettings defaults() {
        return new EngineSettings(DEFAULT_STOP_GRACE, defaultMaxStrays());
    }
}
