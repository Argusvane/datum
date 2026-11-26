package com.argusvane.datum.sandbox.wasi;

/**
 * How a run ended, as the engine saw it.
 *
 * <p>An engine that embeds the module knows how a run ended structurally and says so here, so words on stderr
 * never decide anything the guest could forge (the layer above reads them only after this, as the Datum protocol's
 * {@code RunClassifier} does: a thrown message with an engine's own words stays a failed run).
 */
public enum Termination {
    /** The guest exited, normally or with {@code proc_exit}: {@link RunOutput#exitCode()} says how. */
    EXITED,
    /** The run passed its time budget and was stopped. */
    BUDGET,
    /** The run passed its memory budget (the module could not grow its memory). */
    MEMORY,
    /** The module trapped (unreachable, out of bounds, the shadow stack): {@link RunOutput#trapMessage()}. */
    TRAP,
    /** The run wrote past an output cap and was stopped at once ({@link OutputCapExceededException}). */
    OUTPUT_CAP,
    /** The host cancelled the run (shutdown, a cancelled request, the JVM out of heap); nothing about the guest is known. */
    INTERRUPTED,
    /**
     * The run passed its time budget and the host's backstop past it, was cancelled, and its thread was still going after
     * the stop wait. No engine reports it ({@link RunHarness} ends its own stopped runs as {@link #BUDGET}, however long
     * their threads live): only the host's guard over a runtime that does not enforce its budget does
     * ({@code DatumSandbox}). The run did pass its budget, so the layer above answers it as a budget stop
     * ({@code RunClassifier}: 503 {@code wasm.execution_error}, never the definition's cost); the word stays apart from
     * {@code budget} in the run's trace and metrics, as the Python host's {@code RunEnd.STUCK} does.
     */
    STUCK
}
