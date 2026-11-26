package com.argusvane.datum.webauthn;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import org.jspecify.annotations.Nullable;

/**
 * The verdict on a delivered document's passkey signature ({@link SubmissionSignatureVerifier}'s answer).
 *
 * @param status none (no passkey signature), valid, invalid, or unverifiable (passkeys are not set up)
 * @param reason why it is not valid, in English for the record and the log, or null
 * @param code the reason's code ({@link SubmissionSignatureVerifier#REASONS} or a {@link WebAuthnVerifier}
 *     check), or null
 * @param passkey the passkey that signed: when valid, or when it is the submitter's own (an invalid verdict
 *     names no one else's: the record would show its name); else null
 * @param credentialId the credential id the signature named (at most 1400 characters), for the log, or null
 * @param signedAt when the client says it signed (epoch seconds; its claim, outside the signed text), or null
 * @param scope the scope it signed, or null
 * @param statement the statement it signed, or null
 * @param digest SHA-256 (hex) of the signed text, or null when it was not rebuilt
 * @param signCount the counter the assertion carried
 * @param checks the assertion's checks, when it was verified; else empty
 */
public record SignatureVerification(Status status, @Nullable String reason, @Nullable String code, @Nullable PasskeyRecord passkey,
                                    @Nullable String credentialId, @Nullable Long signedAt, @Nullable String scope, @Nullable String statement,
                                    @Nullable String digest, long signCount, Map<String, Boolean> checks) {

    /** What was found. */
    public enum Status {
        NONE,
        VALID,
        INVALID,
        UNVERIFIABLE;

        /** The record's word: none, valid, invalid, unverifiable. */
        public String wire() {
            return name().toLowerCase(java.util.Locale.ROOT);
        }
    }

    public SignatureVerification {
        checks = checks == null ? Map.of() : Collections.unmodifiableMap(new LinkedHashMap<>(checks));
    }
}
