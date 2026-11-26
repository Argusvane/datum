package com.argusvane.datum.webauthn;

import java.util.Base64;
import org.jspecify.annotations.Nullable;

/**
 * Base64url (RFC 4648 section 5, no padding): how WebAuthn's JSON spells bytes. The JDK's url codec does the
 * work; this wrapper only turns its {@link IllegalArgumentException} into {@code null}, because a malformed
 * field is a refusal on the wire, not an error. The standard alphabet is refused (WebAuthn never sends it),
 * and the JDK reader takes padded or unpadded input.
 */
public final class Base64Url {

    private Base64Url() {
    }

    /** Bytes as base64url, without padding. */
    public static String encode(byte[] bytes) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    /** Bytes from base64url, padded or not; an empty array for ""; null when not base64url. */
    public static byte @Nullable [] decode(@Nullable String text) {
        if (text == null) {
            return null;
        }
        try {
            return Base64.getUrlDecoder().decode(text);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }
}
