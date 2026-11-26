package com.argusvane.datum.sandbox.wasi;

/**
 * The root of what this layer refuses with. Unchecked, and free of any type of the layer
 * above: the Datum protocol and lifecycle translate each subclass once, into their own exceptions and wire codes
 * ({@code ProgramRunner.on} for a run, {@code Engines.create} for an engine's creation), so nothing here decides an HTTP
 * status or a configuration property.
 *
 * <ul>
 *   <li>{@link GuestUnavailableException}: the engine is missing or broken, or a run cannot start;</li>
 *   <li>{@link EngineConfigurationException}: limits the engine cannot honour ({@link MemoryFloorException});</li>
 *   <li>{@link EngineSelectionException}: no engine can be used for the id asked for.</li>
 * </ul>
 *
 * <p>Not every failure is one: a {@link Budget} an engine cannot honour on one run is an {@link IllegalArgumentException}
 * (the caller's mistake), and the stop at an output cap is {@link OutputCapExceededException}, thrown through the guest's
 * write and read by the harness as {@link Termination#OUTPUT_CAP}.
 */
public abstract class WasiException extends RuntimeException {

    private static final long serialVersionUID = 1L;

    protected WasiException(String message) {
        super(message);
    }

    protected WasiException(String message, Throwable cause) {
        super(message, cause);
    }
}
