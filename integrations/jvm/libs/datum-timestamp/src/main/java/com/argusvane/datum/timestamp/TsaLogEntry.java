package com.argusvane.datum.timestamp;

import java.util.Objects;

/**
 * One token about to be issued, as the timestamp server's log keeps it (the shared SQL's V300 {@code datum_tsa_log} row):
 * never a document, which the server never sees.
 *
 * @param genTime the token's genTime as GeneralizedTime text ({@code 20261005120001.25Z}), 32 characters at most
 * @param algorithm the imprint algorithm: {@code sha256}, {@code sha384} or {@code sha512}
 * @param imprint the imprint, lowercase hex: a digest, never a document
 * @param policy the policy object identifier, dotted
 * @param fingerprint the SHA-256, lowercase hex, of the certificate that signs it
 * @param client the client that asked (a {@link TsaClient#id()}), or {@code null} for an open request or the host itself
 * @param channel who asked: {@code http} (a client of the server) or the host itself ({@code sealing}, {@code receipt}, ...)
 */
public record TsaLogEntry(String genTime, String algorithm, String imprint, String policy, String fingerprint, String client,
    String channel) {

    public TsaLogEntry {
        Objects.requireNonNull(genTime, "genTime");
        Objects.requireNonNull(algorithm, "algorithm");
        Objects.requireNonNull(imprint, "imprint");
        Objects.requireNonNull(policy, "policy");
        Objects.requireNonNull(fingerprint, "fingerprint");
        Objects.requireNonNull(channel, "channel");
    }
}
