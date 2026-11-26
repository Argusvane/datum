package com.argusvane.datum.timestamp;

/**
 * No reply came from a timestamp server: it could not be reached, did not answer in time, or answered with more than
 * {@link TsaTransport#MAX_REPLY_BYTES}. An unchecked failure of the transport, which {@link TimestampClient} turns into
 * a {@link TimestampClientException} naming the server.
 */
public class TsaTransportException extends RuntimeException {

    private static final long serialVersionUID = 1L;

    private final int status;

    /**
     * @param status  the HTTP status already received (200 for a reply that was too long), or 0 when no answer started
     * @param problem what went wrong, in plain English without a trailing full stop (it is put in a sentence)
     */
    public TsaTransportException(int status, String problem) {
        super(problem);
        this.status = status;
    }

    public TsaTransportException(int status, String problem, Throwable cause) {
        super(problem, cause);
        this.status = status;
    }

    /** The exchange was not over within the timeout. */
    public static TsaTransportException timedOut(java.time.Duration timeout, Throwable cause) {
        return new TsaTransportException(0, "it did not answer within " + timeout.toMillis() + " ms", cause);
    }

    /** The reply was longer than {@link TsaTransport#MAX_REPLY_BYTES}. */
    public static TsaTransportException tooLarge(Throwable cause) {
        return new TsaTransportException(200, "it answered with more than " + TsaTransport.MAX_REPLY_BYTES + " bytes", cause);
    }

    /** The request could not be made or completed, for the reason the failure gives. */
    public static TsaTransportException failed(Throwable cause) {
        String reason = cause.getMessage() == null ? cause.getClass().getSimpleName() : cause.getMessage();
        return new TsaTransportException(0, reason, cause);
    }

    /** The calling thread was interrupted while it waited (the caller re-sets the interrupt flag). */
    public static TsaTransportException interrupted(Throwable cause) {
        return new TsaTransportException(0, "the request was interrupted", cause);
    }

    /** The HTTP status already received, or 0 when no answer started. */
    public int status() {
        return status;
    }
}
