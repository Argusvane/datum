package com.argusvane.datum.core;

/**
 * A sandbox or PDF program cannot be used: it is missing from the classpath, failed the startup ABI probe,
 * or the runtime that runs it is absent. Maps to 503 {@code server.unavailable}; the submission routes answer
 * the same 503 as {@code validator_unavailable} (the endpoint catalog lists both codes).
 */
public class ProgramUnavailableException extends DatumException {

    private static final long serialVersionUID = 1L;

    public ProgramUnavailableException(String message) {
        super("server.unavailable", 503, message);
    }

    public ProgramUnavailableException(String message, Throwable cause) {
        super("server.unavailable", 503, message, cause);
    }
}
