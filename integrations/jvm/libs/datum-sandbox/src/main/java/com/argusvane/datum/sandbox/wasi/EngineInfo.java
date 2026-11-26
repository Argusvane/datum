package com.argusvane.datum.sandbox.wasi;

import java.util.Locale;
import java.util.Objects;

/**
 * What an engine says about itself: health, the {@code info} contributor and the ready event report it, so none of them
 * names one engine's fields. It says how the engine runs, not what may run on it: whether a given program can run in its
 * budget in this mode is the layer above's decision, read from {@link #isBytecode()} (the Datum lifecycle rules the PDF
 * program out on bytecode).
 *
 * @param id the engine's id, the value that selects it ({@code endive}); for an application's own runtime that reports
 *     nothing, its class name
 * @param version the engine's release, or {@link #UNKNOWN}
 * @param mode how the engine runs the module on this JVM: the name of a native mode ({@code panama}, {@code jffi}),
 *     {@link #BYTECODE}, or {@link #UNKNOWN}; trimmed and lower-cased, so the record always holds one spelling
 * @param notes free text for an operator: why this mode, what was passed over, and what the mode costs; never empty of
 *     meaning, never a secret (it reaches health)
 */
public record EngineInfo(String id, String version, String mode, String notes) {

    /** The mode of an engine that runs the module as JVM bytecode (no native code for this platform). */
    public static final String BYTECODE = "bytecode";

    /** A version or mode the engine does not report. */
    public static final String UNKNOWN = "unknown";

    public EngineInfo {
        Objects.requireNonNull(id, "id");
        if (id.isBlank()) {
            throw new IllegalArgumentException("An engine id is not blank.");
        }
        version = version == null || version.isBlank() ? UNKNOWN : version;
        // One spelling for health, observations and the bytecode refusal: an application's runtime that says
        // "BYTECODE" or " bytecode " is held exactly as one that says "bytecode".
        mode = mode == null || mode.isBlank() ? UNKNOWN : mode.trim().toLowerCase(Locale.ROOT);
        notes = notes == null ? "" : notes;
    }

    /**
     * What a runtime that reports nothing is described as: its class name, nothing known (so not bytecode: the layer
     * above's own gates still decide, and a runtime that cannot run a program answers its probe with a failure).
     */
    public static EngineInfo unreported(String runtimeClass) {
        return new EngineInfo(runtimeClass, UNKNOWN, UNKNOWN, "The runtime reports no engine information.");
    }

    /** Whether the engine runs the module as bytecode here. */
    public boolean isBytecode() {
        return BYTECODE.equals(mode);
    }
}
