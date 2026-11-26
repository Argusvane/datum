package com.argusvane.datum.sandbox.diagnostics;

/**
 * Where the protocol hands each judged run ({@link RunFacts}) when the host diagnoses its runs: the seam between the protocol's
 * services and the runtime's run trace and failed-run capture. The runtime passes one only when
 * the trace or the capture is on; with neither, the services hold none and do nothing per run for it.
 *
 * <p>An observer: it never changes a run's answer. One that throws is logged by the caller and the answer stands.
 */
@FunctionalInterface
public interface RunRecorder {

    /** One judged run, told on the run's own thread before its answer goes back. */
    void ran(RunFacts facts);
}
