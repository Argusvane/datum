package com.argusvane.datum.timestamp;

/**
 * Where a host gets its own RFC 3161 timestamps from: a timestamp server
 * it names ({@link TimestampClient}) or its own ({@link TimestampAuthority}, asked directly with no HTTP).
 *
 * <p>Every request asks for a SHA-256 imprint and the server's certificate in the token, and no nonce: what the
 * PDF program's own request asks.
 */
@FunctionalInterface
public interface Timestamper {

    /**
     * A granted timestamp over data; the server sees only its SHA-256.
     *
     * @param data the bytes to timestamp (a signature value, a receipt statement)
     * @param channel who asks, for the server's log: {@code sealing}, {@code receipt} and so on
     * @return the TimeStampResp, DER, its status granted (or granted with modifications)
     * @throws com.argusvane.datum.core.DatumException when none came: {@link TimestampRefusedException}
     *     from the host's own server, {@link TimestampClientException} from a named one
     */
    byte[] stamp(byte[] data, String channel);
}
