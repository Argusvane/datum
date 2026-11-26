package com.argusvane.datum.sandbox.wasi;

/**
 * Runs the engine's WebAssembly module once over a {@link GuestRun}: the seam an engine module implements (Endive, the only
 * engine; it is a {@link GuestRuntimeProvider} service and builds on the engine-neutral {@link RunHarness}), and the one an
 * application implements to supply its own runtime. It knows no program and no protocol: what the files, arguments and
 * stdin mean is the layer above's (the Datum protocol's {@code ProgramRunner} builds the run and reads its output).
 *
 * <p>What every implementation owes the layer above (the hardening that
 * datum-sandbox-tck's {@code WasiHardeningContract} checks on a real engine):
 * <ul>
 *   <li>a fresh, private, read-only file system per run holding only {@link GuestRun#appFiles()} under {@code /app}, its
 *       only preopen, gone afterwards;</li>
 *   <li>no network, no host environment, no clock beyond what WASI preview 1 gives;</li>
 *   <li>the run's stdin as given, and nothing else to read;</li>
 *   <li>the time and memory limits of the run's {@link Budget} enforced by the engine itself;</li>
 *   <li>stdout and stderr written through {@link BoundedOutputStream}s of the budget's caps, the run stopped at once when
 *       one throws ({@link Termination#OUTPUT_CAP}), never caught and turned into an {@code EIO} the guest could
 *       ignore;</li>
 *   <li>every byte the guest wrote to stdout and stderr before the run ended handed back in the {@link RunOutput},
 *       whatever the {@link Termination}: a run stopped at its time or memory limit, a trap, an output cap or a
 *       cancellation still returns what was written so far (a cancelled task's buffers, not {@code null}). The layer above
 *       reads its own markers from it (the Datum protocol's "started" marker tells a stop the guest ran into from a
 *       runtime that never started); a runtime that drops the bytes turns every such stop into the runtime's fault;</li>
 *   <li>a run that cannot start at all (the engine is missing or broken) throws {@link GuestUnavailableException} or
 *       answers exit 127 before the guest's first line.</li>
 * </ul>
 * Implementations are thread-safe: the caller runs them from many request threads at once (bounded by its own slots).
 */
public interface GuestRuntime {

    /**
     * Runs the module once.
     *
     * @param run the files under {@code /app}, the arguments, stdin and the budget
     * @return how the run ended and what it wrote
     * @throws GuestUnavailableException when the run cannot start
     * @throws IllegalArgumentException when the budget is one this engine cannot honour
     */
    RunOutput run(GuestRun run);

    /**
     * What the engine reports about itself, for health, info and the ready event. The default describes a runtime that
     * reports nothing: its class name, version and mode unknown ({@link EngineInfo#UNKNOWN} is admitted by the layer above).
     *
     * <p>A runtime that wraps another (a metering or tracing decorator) must forward this call. The layer above refuses the
     * PDF program on a bytecode engine by what this reports, and it fails closed: a report that throws or answers null is
     * treated as an engine that cannot run the PDF program.
     */
    default EngineInfo engineInfo() {
        return EngineInfo.unreported(getClass().getName());
    }

    /**
     * Stopped runs whose threads are still alive past the engine's grace, or -1 when the runtime does not count them
     * (health shows the count when there is one).
     */
    default int strayRuns() {
        return -1;
    }
}
