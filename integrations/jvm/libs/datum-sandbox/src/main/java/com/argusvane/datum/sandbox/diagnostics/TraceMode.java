package com.argusvane.datum.sandbox.diagnostics;

import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import org.jspecify.annotations.Nullable;

/** {@code datum.runtime.diagnostics.trace}: which runs get a trace line. */
public enum TraceMode {
    /** None, the default: nothing in the run path is measured, formatted or allocated for a trace. */
    OFF,
    /** Only failed runs: a trap, a cap, a budget, a stop, an unavailable runtime, an answer the protocol refused. */
    FAILURES,
    /** Every run, the proofs and warm-ups included. */
    ALL;

    /** The words the property takes, in order. */
    public static final List<String> WORDS = Arrays.stream(values()).map(TraceMode::word).toList();

    /** The property's word for this mode. */
    public String word() {
        return name().toLowerCase(Locale.ROOT);
    }

    /** Whether a run that failed or not is traced in this mode. */
    public boolean traces(boolean failed) {
        return this == ALL || this == FAILURES && failed;
    }

    /**
     * The mode of a word, or null for one that is none of {@link #WORDS} (the settings refuse it naming the property).
     * Exact words only: the binding lowercases its enum, as for the host words.
     */
    public static @Nullable TraceMode of(@Nullable String word) {
        for (TraceMode mode : values()) {
            if (mode.word().equals(word)) {
                return mode;
            }
        }
        return null;
    }
}
