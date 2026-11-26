package com.argusvane.datum.webauthn;

/**
 * The flags byte of authenticator data (WebAuthn §6.1): UP, UV, BE, BS, AT, ED, read off webauthn4j's authenticator data
 * into the plain record the verdict, the passkey record and the events carry.
 */
public record AuthenticatorFlags(boolean userPresent, boolean userVerified, boolean backupEligible, boolean backedUp,
                                 boolean attestedCredentialData, boolean extensionData) {

    /** Every flag unset: the verdict's flags when nothing could be read. */
    public static final AuthenticatorFlags NONE = new AuthenticatorFlags(false, false, false, false, false, false);

    /** The flags of a flags byte. */
    public static AuthenticatorFlags of(int flags) {
        return new AuthenticatorFlags((flags & 0x01) != 0, (flags & 0x04) != 0, (flags & 0x08) != 0, (flags & 0x10) != 0,
            (flags & 0x40) != 0, (flags & 0x80) != 0);
    }
}
