/**
 * Datum's Endive runtime: {@link com.argusvane.datum.sandbox.wasi.GuestRuntime} over QuickJS-ng's own
 * {@code qjs-wasi.wasm}, compiled at build time by Endive into the class {@code Qjs} (JVM bytecode plus Redline native
 * code for six targets), registered as the {@code endive} engine
 * ({@link com.argusvane.datum.sandbox.endive.EndiveRuntimeProvider}, a
 * {@link com.argusvane.datum.sandbox.wasi.GuestRuntimeProvider} service).
 *
 * <p>The module declares no runner: the selector poms {@code datum-sandbox-endive-jffi} (Java 17+) and
 * {@code datum-sandbox-endive-panama} (Java 25+) bring one, and {@link com.argusvane.datum.sandbox.endive.ProviderSelector}
 * picks it itself rather than through Endive's discovery, so both may ship together. The module sees only datum-sandbox's
 * hardened WASI layer ({@code com.argusvane.datum.sandbox.wasi}): a run is a {@code GuestRun} of files, argv, stdin and a
 * budget, and the run harness there owns the worker thread, the stop at the budget, the read-only in-memory {@code /app},
 * the bounded streams and the strays. The Datum protocol above (the programs, run.js, the frame, the classification, which
 * program may run on which mode) is not named here. This module keeps only what is Endive's: the precompiled class, the
 * runner selection, the memory limits and bookkeeping, the WASI wiring and the reading of Endive's exceptions.
 */
package com.argusvane.datum.sandbox.endive;
