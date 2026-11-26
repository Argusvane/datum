/**
 * Datum's engine test kit: JUnit 5 contract interfaces that an engine module's tests
 * implement against its {@link com.argusvane.datum.sandbox.wasi.GuestRuntime}, in process, with the real
 * programs (datum-programs) and the fixtures pinned by the conformance suite and the PDF kernel.
 *
 * <ul>
 *   <li>{@link com.argusvane.datum.sandbox.tck.WasiHardeningContract}: the hardened WASI run through {@code GuestRuntime}
 *       and {@code GuestRun} alone, with an inline run.js and no Datum program (a fresh read-only {@code /app} of the run's
 *       files, no environment or network, the budget, caps that stop at once, every byte kept, stops in set-up, instances
 *       closed, the stray bound, the memory floor at creation);</li>
 *   <li>{@link com.argusvane.datum.sandbox.tck.RuntimeContract}: the runtime's own promises on the real QuickJS
 *       (a private read-only {@code /app}, confinement, every way a run ends, the started marker kept, caps,
 *       cancellation one at a time and under concurrency, shutdown, parallel streams, a 50-run leak check);</li>
 *   <li>{@link com.argusvane.datum.sandbox.tck.SandboxHardeningContract}: the sandbox hardening through
 *       {@code SandboxService} (the ABI gate refusing a stale program, a rule module that cannot forge, rebind or write
 *       outside the frame, the output cap, the depth guard, the loop, memory and recursion stops);</li>
 *   <li>{@link com.argusvane.datum.sandbox.tck.GoldenVerdictsContract}: the ABI 2.14 golden outcome and the six
 *       control verdicts;</li>
 *   <li>{@link com.argusvane.datum.sandbox.tck.PdfRenderContract}: the ABI 3.8 documents rendered byte for byte
 *       to their pinned hashes.</li>
 * </ul>
 *
 * <p>An implementing class supplies the runtime ({@link com.argusvane.datum.sandbox.tck.RuntimeUnderTest}) and
 * closes it after its tests; the contracts are {@code PER_CLASS}, so their warm-up runs once per class. Endive's
 * {@code WasiHardeningIT}, {@code GoldenIT}, {@code PdfRenderIT}, {@code SandboxHardeningIT} and {@code EndiveRuntimeIT} are
 * the implementations in this repository.
 */
package com.argusvane.datum.sandbox.tck;
