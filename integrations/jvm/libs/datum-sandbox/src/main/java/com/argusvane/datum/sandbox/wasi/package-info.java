/**
 * The hardened WASI run: how a WebAssembly engine is found, chosen and run, with
 * no type of the layer above. Nothing here names a Datum program, the run protocol or a host's settings; a boundary test
 * (datum-sandbox's {@code LibraryBoundaryTest}) holds the package to the JDK, SLF4J, JSpecify, Jimfs and itself.
 *
 * <p>A run is a {@link com.argusvane.datum.sandbox.wasi.GuestRun}: the files of the guest's {@code /app}, its argv, its
 * stdin and its {@link com.argusvane.datum.sandbox.wasi.Budget}. A {@link com.argusvane.datum.sandbox.wasi.GuestRuntime}
 * runs it and hands back a {@link com.argusvane.datum.sandbox.wasi.RunOutput}: how it ended
 * ({@link com.argusvane.datum.sandbox.wasi.Termination}) and every byte it wrote up to the caps. The layer above builds the
 * run and reads the output (the Datum protocol's {@code ProgramRunner}, which puts the program and {@code run.js} under
 * {@code /app}).
 *
 * <p>{@link com.argusvane.datum.sandbox.wasi.GuestRuntimeProvider} is a {@link java.util.ServiceLoader} service:
 * an engine module registers one in {@code META-INF/services}, {@link com.argusvane.datum.sandbox.wasi.GuestRuntimes}
 * finds them and selects one by its id (a host binding reads the id from its configuration), refusing an unknown or
 * unavailable id with the provider's reason and the ids it found, and the provider creates the runtime for the
 * {@link com.argusvane.datum.sandbox.wasi.EngineLimits} it will be given. What the engine reports about itself is an
 * {@link com.argusvane.datum.sandbox.wasi.EngineInfo}, which health, info and the ready event carry instead of any one
 * engine's fields.
 *
 * <p>The engine-neutral half of a run is {@link com.argusvane.datum.sandbox.wasi.RunHarness}: the platform worker
 * thread, the stop at the budget (never during set-up), a fresh read-only in-memory {@code /app} holding only the run's
 * files as the only preopen, no environment, the bounded streams whose cap ends the run at once, every byte written handed
 * back however the run ended, the instance closed however {@code _start} ended, the stray-run bound and the reading of how
 * a run ended (the JVM out of heap and a host interrupt as the host's stop). An engine implements only
 * {@link com.argusvane.datum.sandbox.wasi.GuestEngine}: instantiate the module over the streams and the directory it
 * is handed, call {@code _start}, and say what its own exceptions mean. Endive is the only engine (datum-sandbox-endive);
 * the in-process kit datum-sandbox-tck holds any engine to the same guarantees ({@code WasiHardeningContract}).
 *
 * <p>What this layer refuses with is a {@link com.argusvane.datum.sandbox.wasi.WasiException}: a run that cannot start
 * ({@link com.argusvane.datum.sandbox.wasi.GuestUnavailableException}), limits an engine cannot honour
 * ({@link com.argusvane.datum.sandbox.wasi.EngineConfigurationException}) and an engine that cannot be selected
 * ({@link com.argusvane.datum.sandbox.wasi.EngineSelectionException}). The layer above translates them once into its own
 * exceptions and wire codes.
 *
 * <p>Nullability: the package is {@code @NullMarked}, so a type with no annotation is
 * non-null and {@code @Nullable} marks the places a null is meant (an optional member, an unset option, a "none" answer).
 */
@NullMarked
package com.argusvane.datum.sandbox.wasi;

import org.jspecify.annotations.NullMarked;
