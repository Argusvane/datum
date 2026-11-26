/**
 * The sandbox run protocol, written once for every runtime.
 *
 * <p>The run protocol and its hardening: the generated {@code run.js}
 * ({@link com.argusvane.datum.sandbox.protocol.RunScript}), the per-run nonce on stdin
 * ({@link com.argusvane.datum.sandbox.protocol.Nonce}), the strict answer frame
 * ({@link com.argusvane.datum.sandbox.protocol.Frame}), the output caps and
 * the run's budgets ({@link com.argusvane.datum.sandbox.protocol.ProgramLimits}), the ABI gate
 * ({@link com.argusvane.datum.sandbox.protocol.AbiProbe}) and the classification of a finished run
 * ({@link com.argusvane.datum.sandbox.protocol.RunClassifier}).
 *
 * <p>It sits on the hardened WASI run ({@code com.argusvane.datum.sandbox.wasi}), which knows no Datum type:
 * {@link com.argusvane.datum.sandbox.protocol.ProgramRunner#on} is the one place a run of a
 * {@link com.argusvane.datum.sandbox.protocol.Program} becomes a {@link com.argusvane.datum.sandbox.wasi.GuestRun} (the
 * program's bytes under its file name and {@code run.js} in {@code /app}) and the one place a
 * {@link com.argusvane.datum.sandbox.wasi.GuestUnavailableException} becomes the protocol's 503. What actually executes
 * QuickJS is a {@link com.argusvane.datum.sandbox.wasi.GuestRuntime}, which an engine module provides (Endive); nothing
 * here knows which one runs.
 *
 * <p>Nullability: the package is {@code @NullMarked}, so a type with no annotation is
 * non-null and {@code @Nullable} marks the places a null is meant (an optional member, an unset option, a "none" answer).
 */
@NullMarked
package com.argusvane.datum.sandbox.protocol;

import org.jspecify.annotations.NullMarked;
