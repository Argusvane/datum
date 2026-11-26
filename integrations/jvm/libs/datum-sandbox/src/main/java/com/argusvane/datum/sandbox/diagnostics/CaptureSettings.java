package com.argusvane.datum.sandbox.diagnostics;

import org.jspecify.annotations.Nullable;
import java.nio.file.Path;

/**
 * {@code datum.runtime.diagnostics.capture.*}: whether failed runs are kept for debugging, where, and how many. The bounds hold for every {@link RunCaptureSink}, the file sink and a host's own alike; the directory is the file
 * sink's and is required only when it is the sink.
 *
 * @param enabled whether failed runs are captured (false by default: a capture holds the submitted answers and the form
 *     definition in clear text)
 * @param directory where the file sink writes, or null (required when enabled and no sink of the host's own is given)
 * @param maxRuns the most captures kept; the oldest go first (at least 1)
 * @param maxBytes the most bytes all kept captures take together; a single capture larger than this is dropped (at least 1)
 * @param queueBytes the most bytes of captures waiting to be written; one that does not fit is dropped (at least 1)
 */
public record CaptureSettings(boolean enabled, @Nullable Path directory, int maxRuns, long maxBytes, long queueBytes) {

    /** The default of {@code max-runs}. */
    public static final int DEFAULT_MAX_RUNS = 20;
    /** The default of {@code max-bytes}: 64 MiB. */
    public static final long DEFAULT_MAX_BYTES = 64L * 1024 * 1024;
    /** The default of {@code queue-bytes}: 64 MiB. */
    public static final long DEFAULT_QUEUE_BYTES = 64L * 1024 * 1024;

    public CaptureSettings {
        if (maxRuns < 1 || maxBytes < 1 || queueBytes < 1) {
            throw new IllegalArgumentException("The capture bounds are at least 1: max-runs " + maxRuns + ", max-bytes " + maxBytes
                + ", queue-bytes " + queueBytes + ".");
        }
    }

    /** Capture off, at the default bounds. */
    public static CaptureSettings off() {
        return new CaptureSettings(false, null, DEFAULT_MAX_RUNS, DEFAULT_MAX_BYTES, DEFAULT_QUEUE_BYTES);
    }
}
