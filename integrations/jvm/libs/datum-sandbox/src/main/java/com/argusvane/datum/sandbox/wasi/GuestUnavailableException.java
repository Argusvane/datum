package com.argusvane.datum.sandbox.wasi;

/**
 * The guest cannot be run: the engine is missing or broken (its module would not instantiate, a native runner failed to
 * link), the run's file system could not be made, or the harness is refusing runs while too many stopped runs are still
 * alive ({@link EngineSettings#maxStrays()}). Nothing about the guest is known, so the layer above answers it as its
 * runtime's outage (the Datum protocol: {@code ProgramUnavailableException}, 503 {@code server.unavailable}), never as
 * the guest's fault.
 */
public class GuestUnavailableException extends WasiException {

    private static final long serialVersionUID = 1L;

    public GuestUnavailableException(String message) {
        super(message);
    }

    public GuestUnavailableException(String message, Throwable cause) {
        super(message, cause);
    }
}
