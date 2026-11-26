/**
 * What an operator reads to see how the sandbox runs and why a run failed, plain
 * data and plain Java with no framework type, so a binding prints it at start, an actuator endpoint serves it and a plain-Java
 * host uses it the same way:
 * <ul>
 *   <li>the effective settings and where each value came from ({@link com.argusvane.datum.sandbox.diagnostics.SettingsReport}),
 *       and the startup report around them ({@link com.argusvane.datum.sandbox.diagnostics.SandboxReport});</li>
 *   <li>the run trace, one record per run ({@link com.argusvane.datum.sandbox.diagnostics.TraceRecord}) through the
 *       {@link com.argusvane.datum.sandbox.diagnostics.RunTrace} seam, off by default
 *       ({@link com.argusvane.datum.sandbox.diagnostics.TraceMode});</li>
 *   <li>the failed-run capture ({@link com.argusvane.datum.sandbox.diagnostics.FailedRunCapture}), bounded and off the run
 *       thread, through the {@link com.argusvane.datum.sandbox.diagnostics.RunCaptureSink} seam, by default a hardened directory
 *       ({@link com.argusvane.datum.sandbox.diagnostics.DirectoryCaptureSink}).</li>
 * </ul>
 * The protocol hands each judged run to a {@link com.argusvane.datum.sandbox.diagnostics.RunRecorder} as
 * {@link com.argusvane.datum.sandbox.diagnostics.RunFacts} only when the trace or the capture is on.
 *
 * <p>Nullability: the package is {@code @NullMarked}; {@code @Nullable} marks the places a null is meant.
 */
@NullMarked
package com.argusvane.datum.sandbox.diagnostics;

import org.jspecify.annotations.NullMarked;
