package com.argusvane.datum.sandbox.diagnostics;

import java.util.Objects;
import java.util.regex.Pattern;

/**
 * The rules every diagnostics observer is held to, in one place so the run path, the capture's
 * writer and the report apply the same ones: an observer never changes a run's answer and never stops a start, whatever it
 * throws; a host's description of its seam is read once, guarded, and printed scrubbed.
 *
 * <p>Which failures pass through ({@link #rethrowFatal}): an observer's {@code Error} would otherwise replace the run's own
 * answer (a {@code SandboxException} after a run that ran out of heap, say), so every {@code Throwable} is caught, except a
 * {@link VirtualMachineError} that says the JVM itself is broken ({@link InternalError}, {@link UnknownError}). An
 * {@link OutOfMemoryError} or a {@link StackOverflowError} raised while building a capture or a trace record is that record's
 * failure, not the JVM's: the record is lost and counted, and the run's answer stands.
 */
public final class Guarded {

    /** A URL's user and password: {@code scheme://user:password@}. */
    private static final Pattern USER_INFO = Pattern.compile("(?<=://)[^/@\\s]+@");

    /**
     * A query value: {@code ?name=value} or {@code &name=value}, up to the next {@code &}, {@code #}, blank, quote or closing
     * bracket (a location is often printed inside one: {@code URL [https://host/x.js?sig=...]}).
     */
    private static final Pattern QUERY_VALUE = Pattern.compile("([?&][^=&#\\s\\])\"']+=)[^&#\\s\\])\"']*");

    private Guarded() {
    }

    /**
     * Rethrows {@code failure} when it says the JVM is broken: a {@link VirtualMachineError} other than an
     * {@link OutOfMemoryError} or a {@link StackOverflowError}. Every other failure returns, for the caller to count.
     */
    public static void rethrowFatal(Throwable failure) {
        if (failure instanceof VirtualMachineError fatal && !(failure instanceof OutOfMemoryError) && !(failure instanceof StackOverflowError)) {
            throw fatal;
        }
    }

    /** What a sink says it stores to, scrubbed; its class name when {@code describe()} throws or answers nothing. */
    public static String describe(RunCaptureSink sink) {
        Objects.requireNonNull(sink, "sink");
        try {
            String described = sink.describe();
            return described == null ? sink.getClass().getName() : scrub(described);
        } catch (Throwable e) {
            rethrowFatal(e);
            return sink.getClass().getName();
        }
    }

    /** What a trace says it goes to, scrubbed; its class name when {@code describe()} throws or answers nothing. */
    public static String describe(RunTrace trace) {
        Objects.requireNonNull(trace, "trace");
        try {
            String described = trace.describe();
            return described == null ? trace.getClass().getName() : scrub(described);
        } catch (Throwable e) {
            rethrowFatal(e);
            return trace.getClass().getName();
        }
    }

    /**
     * A text with every URL's user and password as {@code ***@} and every query value as {@code ***}
     * ({@code https://***@minio/captures?token=***}): what the report, the start WARN and a capture's {@code meta.json} print of
     * anything a host or an engine wrote (a description, a location, the engine's notes).
     */
    public static String scrub(String text) {
        String withoutUser = USER_INFO.matcher(Objects.requireNonNull(text, "text")).replaceAll("***@");
        return QUERY_VALUE.matcher(withoutUser).replaceAll("$1***");
    }
}
