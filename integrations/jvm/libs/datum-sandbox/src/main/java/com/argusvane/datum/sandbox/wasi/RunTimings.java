package com.argusvane.datum.sandbox.wasi;

/**
 * Where one run's wall time went inside the harness, for a run that asked to be timed ({@link GuestRun#timed()}): the
 * engine's set-up on the caller's thread, the module's instantiation and its {@code _start} on the run's own thread. Engine
 * neutral: {@link RunHarness} measures the three steps of {@link GuestEngine}, whatever engine is behind them. A run that is
 * not timed carries none ({@link RunOutput#timings()} is null), so nothing is measured for it.
 *
 * <p>A step that did not happen (a run stopped during set-up never reaches {@code _start}) is {@link #NOT_RUN}. A step still
 * going when the run was answered (a run stopped at its budget whose thread had not ended) is measured up to that answer.
 *
 * @param prepareNanos {@link GuestEngine#prepare}, or {@link #NOT_RUN}
 * @param instantiateNanos {@link GuestEngine.Prepared#instantiate()}, or {@link #NOT_RUN}
 * @param startNanos {@link GuestEngine.Instance#start()}, or {@link #NOT_RUN}
 */
public record RunTimings(long prepareNanos, long instantiateNanos, long startNanos) {

    /** A step that did not happen. */
    public static final long NOT_RUN = -1;

    public RunTimings {
        prepareNanos = clean(prepareNanos);
        instantiateNanos = clean(instantiateNanos);
        startNanos = clean(startNanos);
    }

    private static long clean(long nanos) {
        return nanos < 0 ? NOT_RUN : nanos;
    }

    /** Nanoseconds as milliseconds, or -1 for {@link #NOT_RUN}. */
    public static double millis(long nanos) {
        return nanos < 0 ? -1 : nanos / 1e6;
    }
}
