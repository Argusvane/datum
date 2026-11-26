package com.argusvane.datum.pdf.verify;

/**
 * A signature's RFC 3161 timestamp, checked here: a signature entry's {@code timestamp} in the verify report.
 *
 * @param time the token's genTime as the program read it (a claim unless {@code verified})
 * @param tsa the name the token gives itself, or null
 * @param coversSignature its imprint is this signature value's digest
 * @param verified everything about the token holds
 * @param trust {@code site} (this server's timestamp authority, by fingerprint), {@code trusted} (under a trust
 *     anchor), {@code unknown} (holds, nobody here vouches for its signer) or {@code invalid}
 * @param site trust is {@code site}
 * @param signer the certificate that signed it, when its signature holds
 * @param signerSource {@code token}, {@code known} or null: where the program found the certificate the token names
 * @param problem {@code unreadable}, {@code imprint}, {@code signature}, {@code binding} or {@code time}; null when
 *     everything holds
 */
public record TimestampVerdict(String time, String tsa, boolean coversSignature, boolean verified, String trust, boolean site,
                               Signer signer, String signerSource, String problem) {

    /** The timestamp authority's certificate. */
    public record Signer(String subject, String commonName, String fingerprint) {
    }
}
