package com.argusvane.datum.timestamp;

import com.argusvane.datum.core.DatumException;

/**
 * No timestamp came from a named timestamp server: it did not
 * answer, answered with another HTTP status, or did not grant a timestamp. The message says, in plain English for
 * a log, which server was asked and what went wrong, and ends with a full stop; it never carries the client key.
 */
public class TimestampClientException extends DatumException {

    private static final long serialVersionUID = 1L;

    /** The wire code a JSON error body would carry. */
    public static final String CODE = "timestamp.unavailable";

    private final int status;

    /**
     * @param status the HTTP status the server answered with, or 0 when it did not answer
     * @param message what went wrong
     */
    public TimestampClientException(int status, String message) {
        super(CODE, 503, message);
        this.status = status;
    }

    public TimestampClientException(int status, String message, Throwable cause) {
        super(CODE, 503, message, cause);
        this.status = status;
    }

    /** The HTTP status the server answered with (200 for a reply that granted nothing), or 0 when it did not answer. */
    public int status() {
        return status;
    }
}
