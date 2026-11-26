package com.argusvane.datum.webauthn;

/**
 * A {@link PasskeyRepository} refused a passkey whose credential id or public key is stored already: two
 * registrations of one credential (or of one key under two credential ids) racing, the unique key refusing the
 * second (the shared SQL's unique keys).
 */
public class DuplicatePasskeyException extends RuntimeException {

    private static final long serialVersionUID = 1L;

    public DuplicatePasskeyException(String message) {
        super(message);
    }

    public DuplicatePasskeyException(String message, Throwable cause) {
        super(message, cause);
    }
}
