package com.argusvane.datum.timestamp;

import com.argusvane.datum.core.DatumException;
import java.util.Objects;

/**
 * A timestamp request refused (RFC 3161 status rejection): the refusal is a value ({@link TimestampRefusal}) this
 * exception carries, so a web adapter
 * answers {@link TimestampRefusal#toResponse()} with {@link #httpStatus()}.
 *
 * <p>The message is the statusString the client reads; it never carries a key, a stack trace or a store's
 * error (those go to the log only).
 */
public class TimestampRefusedException extends DatumException {

    private static final long serialVersionUID = 1L;

    /** The wire code a JSON error body would carry. */
    public static final String CODE = "timestamp.refused";

    private final transient TimestampRefusal refusal;

    public TimestampRefusedException(TimestampRefusal refusal) {
        super(CODE, refusal.httpStatus(), refusal.message());
        this.refusal = Objects.requireNonNull(refusal, "refusal");
    }

    public TimestampRefusedException(int failInfo, String message) {
        this(new TimestampRefusal(failInfo, message));
    }

    /** The refusal: its failInfo bit, statusString and TimeStampResp. */
    public TimestampRefusal refusal() {
        return refusal;
    }

    /** The PKIFailureInfo bit ({@code TimestampRefusal.FAIL_*}). */
    public int failInfo() {
        return refusal.failInfo();
    }
}
