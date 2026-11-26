package com.argusvane.datum.webauthn;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import org.jspecify.annotations.Nullable;

/**
 * The verdict on a WebAuthn ceremony ({@link WebAuthnVerifier}'s answer): each check in order, the flags
 * and counter read, the first check that failed and its reason, and for a valid registration the credential.
 *
 * @param valid whether every check passed
 * @param checks each check by name, in the order they run ({@link WebAuthnVerifier#REASONS}): true when it ran and passed,
 *     false when it failed or was not reached (the library stops at its first refusal)
 * @param flags the flags read; {@link AuthenticatorFlags#NONE} when nothing could be read
 * @param signCount the counter read; 0 when nothing could be read
 * @param failed the first check that failed, or null: a key of {@link WebAuthnVerifier#REASONS} (a webauthn4j refusal
 *     this site has no name for is {@value WebAuthnVerifier#LIBRARY_CHECK})
 * @param reason the failure in English (for logs and the record; a library refusal names the library's exception), or
 *     null
 * @param credential for a valid registration, what it registers; else null
 */
public record WebAuthnVerdict(boolean valid, Map<String, Boolean> checks, AuthenticatorFlags flags, long signCount, @Nullable String failed,
                              @Nullable String reason, @Nullable RegisteredCredential credential) {

    public WebAuthnVerdict {
        checks = Collections.unmodifiableMap(new LinkedHashMap<>(checks));
    }

    /**
     * What a valid registration yields, all from the authenticator data and the client data: none of it judged
     * beyond the checks (attestation "none" proves nothing about the authenticator's make).
     *
     * @param credentialId the credential id (raw); copied
     * @param spki its public key, SPKI DER; copied
     * @param algorithm its COSE algorithm
     * @param aaguid the authenticator's AAGUID as 8-4-4-4-12 text ("" when it is not 16 bytes)
     * @param origin the origin the client data names
     * @param attestationFormat the attestation object's format ("none"), or "" when the browser sent none
     */
    public record RegisteredCredential(byte[] credentialId, byte[] spki, int algorithm, String aaguid, String origin, String attestationFormat) {

        public RegisteredCredential {
            credentialId = credentialId.clone();
            spki = spki.clone();
        }

        @Override
        public byte[] credentialId() {
            return credentialId.clone();
        }

        @Override
        public byte[] spki() {
            return spki.clone();
        }
    }
}
