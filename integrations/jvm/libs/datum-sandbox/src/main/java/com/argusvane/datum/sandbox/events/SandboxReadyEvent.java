package com.argusvane.datum.sandbox.events;

import com.argusvane.datum.sandbox.wasi.EngineInfo;

/**
 * The runtime proved its programs and warmed up: published once at context start (and again after a
 * successful {@code recheck()}).
 *
 * <p>Delivery: synchronously on the thread that started (or rechecked) the runtime, after it is UP; no
 * transaction. A listener that throws is logged and the runtime stays UP (with fail-fast on, the start goes on); it cannot
 * veto the start.
 *
 * @param engine what the engine reports about itself: its id ({@code endive}, or the class name of an
 *     application's own {@code GuestRuntime} that reports none), version, mode ({@code panama}, {@code jffi},
 *     {@code bytecode}, {@code unknown}), whether it runs the PDF program, and notes
 * @param sandboxAbi the sandbox program's ABI (from {@code programs.json}; the floor it was proved for when the
 *     program is an override)
 * @param pdfAbi the PDF program's ABI likewise, or null when the PDF program is unavailable
 * @param warmUpMillis the wall time of the warm-up runs
 */
public record SandboxReadyEvent(EngineInfo engine, String sandboxAbi, String pdfAbi, long warmUpMillis) {
}
