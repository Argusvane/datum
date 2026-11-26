package com.argusvane.datum.timestamp;

import java.time.Instant;
import java.util.Objects;

/**
 * A token issued: the granted TimeStampResp and what the server's log and events say of it.
 *
 * @param response the TimeStampResp, DER: {@code SEQ{SEQ{INTEGER 0}, token}}
 * @param token the TimeStampToken alone (a CMS ContentInfo), DER
 * @param serial its serial number
 * @param genTime its genTime
 * @param genTimeText genTime as the token writes it ({@code 20261005120001.25Z})
 * @param algorithm the imprint algorithm: {@code sha256}, {@code sha384} or {@code sha512}
 * @param imprint the imprint, raw
 * @param policy the policy, dotted
 * @param fingerprint the SHA-256, lowercase hex, of the certificate that signed it
 * @param client the client that asked, or {@code null}
 * @param channel who asked: {@code http}, {@code sealing}, ...
 */
public record TimestampResponse(byte[] response, byte[] token, long serial, Instant genTime, String genTimeText, String algorithm,
    byte[] imprint, String policy, String fingerprint, String client, String channel) {

    public TimestampResponse {
        response = Objects.requireNonNull(response, "response").clone();
        token = Objects.requireNonNull(token, "token").clone();
        imprint = Objects.requireNonNull(imprint, "imprint").clone();
        Objects.requireNonNull(genTime, "genTime");
    }

    @Override
    public byte[] response() {
        return response.clone();
    }

    @Override
    public byte[] token() {
        return token.clone();
    }

    @Override
    public byte[] imprint() {
        return imprint.clone();
    }
}
