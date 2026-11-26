package com.argusvane.datum.webauthn;

import com.argusvane.datum.core.DatumException;
import org.jspecify.annotations.Nullable;

/**
 * A refused passkey registration, with its wire code, status and words (endpoint catalog {@code passkeyRegister}):
 * {@code passkey.bad_request} 400 (the body could not be read), {@code passkey.challenge} 400 (the
 * challenge expired, was used, or is for something else), {@code passkey.invalid} 422 (a WebAuthn check failed,
 * or the passkey was made for another user handle), {@code passkey.exists} 409 (its credential id or its public
 * key is registered already).
 *
 * <p>Not shorthand codes (challenge, attestation, duplicate...): the wire codes are the catalog's, as every
 * capability keeps them (PKY-01..04).
 */
public class PasskeyException extends DatumException {

    private static final long serialVersionUID = 1L;

    private final @Nullable String check;

    public PasskeyException(String code, int httpStatus, String message, @Nullable String check) {
        super(code, httpStatus, message);
        this.check = check;
    }

    /** The check that failed, for the log ({@link WebAuthnVerifier#REASONS} or "handle"), or null. */
    public @Nullable String check() {
        return check;
    }
}
