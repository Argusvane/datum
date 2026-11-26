package com.argusvane.datum.timestamp;

import java.util.Objects;

/**
 * What an endpoint answers a TimeStampReq with ({@link TimestampAuthority#respond}): always a TimeStampResp body,
 * granted or a rejection, with its HTTP status.
 *
 * @param status 200; 400 when the request is at fault; 503 when the server is
 * @param body the TimeStampResp, DER ({@code application/timestamp-reply})
 * @param issued the token issued, or {@code null} for a refusal
 * @param refusal the refusal, or {@code null} for a token
 */
public record TimestampReply(int status, byte[] body, TimestampResponse issued, TimestampRefusal refusal) {

    public TimestampReply {
        body = Objects.requireNonNull(body, "body").clone();
        if ((issued == null) == (refusal == null)) {
            throw new IllegalArgumentException("A reply is a token or a refusal");
        }
    }

    @Override
    public byte[] body() {
        return body.clone();
    }

    /** Whether a token was issued. */
    public boolean granted() {
        return issued != null;
    }
}
