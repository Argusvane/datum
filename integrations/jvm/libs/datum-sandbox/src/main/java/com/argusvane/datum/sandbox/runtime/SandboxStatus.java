package com.argusvane.datum.sandbox.runtime;

import com.argusvane.datum.sandbox.diagnostics.FailedRunCapture;
import com.argusvane.datum.sandbox.wasi.EngineInfo;
import java.util.LinkedHashMap;
import java.util.Map;
import org.jspecify.annotations.Nullable;

/**
 * The runtime as health and the actuator's recheck report it: UP once both programs were proved and the
 * warm-up runs gave the expected verdict; DOWN with the reason otherwise; the slots in use.
 *
 * @param state where the runtime is
 * @param reason why it is DOWN (or why it is STARTING/STOPPED), else null
 * @param engine what the engine reports about itself: health shows its id ({@code engine}), version, mode
 *     ({@code panama}, {@code jffi}, {@code bytecode}, {@code unknown}), whether the PDF program can run on it
 *     ({@code pdfCapable}, from {@code pdfRunnable}), and its notes
 * @param pdfRunnable whether the PDF program can run on the engine ({@code ProgramRunner.canRunPdf}: not on bytecode, not
 *     when the engine's report cannot be read, and not with no engine at all)
 * @param sandboxAbi the sandbox program's ABI, when proved
 * @param pdfAbi the PDF program's ABI, when proved
 * @param pdfUnavailable why the PDF program is unavailable, or null when it is usable
 * @param validationSlots validation slots
 * @param validationSlotsFree validation slots free now
 * @param pdfSlots PDF slots
 * @param pdfSlotsFree PDF slots free now
 * @param inFlight runs in flight now
 * @param warmUpMillis the last warm-up's wall time
 * @param stuckRuns runs this runtime cancelled past the backstop whose threads are still going
 * @param strayRuns runs the engine stopped whose threads are still alive past its grace, or -1 when the engine does not count them
 * @param capture the failed-run capture's counts when it is enabled, else null (health then shows nothing of it)
 */
public record SandboxStatus(State state, String reason, EngineInfo engine, boolean pdfRunnable, String sandboxAbi, String pdfAbi,
                            String pdfUnavailable, int validationSlots, int validationSlotsFree, int pdfSlots, int pdfSlotsFree,
                            int inFlight, long warmUpMillis, int stuckRuns, int strayRuns, FailedRunCapture.@Nullable Counts capture) {

    public SandboxStatus {
        java.util.Objects.requireNonNull(engine, "engine");
    }

    /** A status with the capture off. */
    public SandboxStatus(State state, String reason, EngineInfo engine, boolean pdfRunnable, String sandboxAbi, String pdfAbi,
                         String pdfUnavailable, int validationSlots, int validationSlotsFree, int pdfSlots, int pdfSlotsFree,
                         int inFlight, long warmUpMillis, int stuckRuns, int strayRuns) {
        this(state, reason, engine, pdfRunnable, sandboxAbi, pdfAbi, pdfUnavailable, validationSlots, validationSlotsFree, pdfSlots,
            pdfSlotsFree, inFlight, warmUpMillis, stuckRuns, strayRuns, null);
    }

    /** Where the runtime is. */
    public enum State {
        /** Not started yet: every run answers 503. */
        STARTING,
        /** Proved and warmed up. */
        UP,
        /** The programs could not be proved, or the warm-up failed: every run answers 503 until a recheck passes. */
        DOWN,
        /** Shut down. */
        STOPPED
    }

    /** What health shows. */
    public Map<String, Object> details() {
        Map<String, Object> details = new LinkedHashMap<>();
        details.put("state", state.name());
        if (reason != null) {
            details.put("reason", reason);
        }
        details.put("engine", engine.id());
        details.put("engineRelease", engine.version());
        details.put("engineMode", engine.mode());
        // The runtime's decision from the engine's mode (ProgramRunner.canRunPdf), under the key health has always shown.
        details.put("pdfCapable", pdfRunnable);
        if (!engine.notes().isEmpty()) {
            details.put("engineNotes", engine.notes());
        }
        if (sandboxAbi != null) {
            details.put("sandboxAbi", sandboxAbi);
        }
        if (pdfAbi != null) {
            details.put("pdfAbi", pdfAbi);
        }
        if (pdfUnavailable != null) {
            details.put("pdfUnavailable", pdfUnavailable);
        }
        details.put("validationSlots", validationSlots);
        details.put("validationSlotsInUse", validationSlots - validationSlotsFree);
        details.put("pdfSlots", pdfSlots);
        details.put("pdfSlotsInUse", pdfSlots - pdfSlotsFree);
        details.put("runsInFlight", inFlight);
        details.put("warmUpMillis", warmUpMillis);
        details.put("stuckRuns", stuckRuns);
        if (strayRuns >= 0) {
            details.put("strayRuns", strayRuns);
        }
        if (capture != null) {
            // Only when the capture is on: the runtime entry is otherwise unchanged.
            Map<String, Object> counts = new LinkedHashMap<>();
            counts.put("dropped", capture.dropped());
            counts.put("failed", capture.failed());
            details.put("capture", counts);
        }
        return details;
    }

    /** Whether the runtime is up: what a framework's health check reports, beside {@link #details()}. */
    public boolean isUp() {
        return state == State.UP;
    }
}
