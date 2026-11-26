package com.argusvane.datum.timestamp;

import com.argusvane.datum.core.DatumException;

/**
 * The timestamp server's key cannot be loaded or used: missing, unreadable, a key and certificate that do not
 * match, or a certificate {@link TsaCertificateRules} refuses. {@link TimestampAuthority} turns it into a systemFailure
 * refusal and logs the message.
 */
public class TsaKeyException extends DatumException {

    private static final long serialVersionUID = 1L;

    /** The wire code a JSON error body would carry. */
    public static final String CODE = "timestamp.key";

    public TsaKeyException(String message) {
        super(CODE, 503, message);
    }

    public TsaKeyException(String message, Throwable cause) {
        super(CODE, 503, message, cause);
    }
}
