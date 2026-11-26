package com.argusvane.datum.core;

/**
 * A request body, a definition or a run's input is larger than its cap. Maps to 413
 * {@code bad_document}, the answer the conformance suite's REC-03 asks for a body past its cap.
 */
public class RequestTooLargeException extends DatumException {

    private static final long serialVersionUID = 1L;

    private final long limit;

    public RequestTooLargeException(long limit, String message) {
        super("bad_document", 413, message);
        this.limit = limit;
    }

    /** The cap in bytes (or items) that was exceeded. */
    public long limit() {
        return limit;
    }
}
