package com.argusvane.datum.core;

/**
 * Base of every unchecked exception the Datum modules throw.
 *
 * <p>Each carries a stable machine {@link #code()} (the wire codes of the endpoint catalog and the TypeScript
 * {@code http-mapping.ts}, for example {@code server.unavailable} or {@code outcome_too_large})
 * and an {@link #httpStatus()} hint the web adapter maps once. Messages never carry guest stderr or
 * sandbox output; those go to the log only.
 */
public class DatumException extends RuntimeException {

    private static final long serialVersionUID = 1L;

    private final String code;
    private final int httpStatus;

    public DatumException(String code, int httpStatus, String message) {
        super(message);
        this.code = code;
        this.httpStatus = httpStatus;
    }

    public DatumException(String code, int httpStatus, String message, Throwable cause) {
        super(message, cause);
        this.code = code;
        this.httpStatus = httpStatus;
    }

    /** The stable wire code. */
    public String code() {
        return code;
    }

    /** The HTTP status the web adapter answers with; a hint, since the core knows no web stack. */
    public int httpStatus() {
        return httpStatus;
    }

    /**
     * The low-cardinality {@code outcome} word an observation records for this failure, or null for the default
     * ({@code refused}). A subclass with a fixed reason set (the sandbox's refusals) answers its reason.
     */
    public @org.jspecify.annotations.Nullable String observationOutcome() {
        return null;
    }
}
