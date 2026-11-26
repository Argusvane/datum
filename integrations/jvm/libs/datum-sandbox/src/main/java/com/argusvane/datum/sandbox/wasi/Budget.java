package com.argusvane.datum.sandbox.wasi;

/**
 * What one run may take: wall time, linear memory and output.
 *
 * <p>The time and memory are the engine's own limits (its stop at the deadline and its memory pages, never flags
 * on the guest's command line, which the guest could ignore); the output caps are separate because the memory
 * limit does not bound output (a guest wrote 200 MiB under a 32 MiB cap). A
 * {@link GuestRuntime} writes stdout and stderr through {@link BoundedOutputStream}s of these sizes, so a run that passes
 * either stops at once. Part of every {@link GuestRun}; the layer above decides the numbers (the Datum protocol's
 * {@code ProgramLimits}).
 *
 * @param seconds the time budget, set-up included
 * @param memoryBytes the linear memory budget
 * @param stdoutCap the most the run may write to stdout, in bytes ({@link #STDOUT_LIMIT} unless the caller needs more)
 * @param stderrCap the most the run may write to stderr, in bytes ({@link #STDERR_LIMIT})
 */
public record Budget(int seconds, long memoryBytes, long stdoutCap, long stderrCap) {

    /**
     * The default stdout cap: 32 MiB, which a Datum validation or inspect run is held to. An outcome of 10,000 errors
     * is about 1.2 MB.
     */
    public static final long STDOUT_LIMIT = 32L * 1024 * 1024;

    /** The default stderr cap: 64 KiB, which every Datum run is held to. */
    public static final long STDERR_LIMIT = 64L * 1024;

    /**
     * The largest output cap a runtime can honour: the longest Java array ({@code ByteArrayOutputStream} and
     * {@link RunOutput}'s {@code byte[]} hold the output). A larger cap could never trigger: the buffer would
     * fail with an {@link OutOfMemoryError} before {@link OutputCapExceededException}, so a run would end in
     * an {@code Error} instead of a classified {@link Termination#OUTPUT_CAP}.
     */
    public static final long MAX_OUTPUT_CAP = Integer.MAX_VALUE - 8;

    public Budget {
        if (seconds <= 0 || memoryBytes <= 0 || stdoutCap <= 0 || stderrCap <= 0) {
            throw new IllegalArgumentException("Every part of a budget is above zero: " + seconds + " s, " + memoryBytes
                + " bytes, stdout " + stdoutCap + ", stderr " + stderrCap);
        }
        if (stdoutCap > MAX_OUTPUT_CAP || stderrCap > MAX_OUTPUT_CAP) {
            throw new IllegalArgumentException("An output cap is at most " + MAX_OUTPUT_CAP + " bytes: stdout " + stdoutCap
                + ", stderr " + stderrCap);
        }
    }
}
