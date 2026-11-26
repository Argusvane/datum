package com.argusvane.datum.webauthn;

/**
 * Who is making a passkey or signing: an account, or an anonymous visitor.
 *
 * @param uid the principal's stable id ("" for an anonymous visitor); never shown, and never the user handle
 * @param name the account's name, for the passkey's user entity
 * @param displayName the name the browser shows
 */
public record PasskeySubject(String uid, String name, String displayName) {

    private static final PasskeySubject ANONYMOUS = new PasskeySubject("", "", "");

    public PasskeySubject {
        uid = uid == null ? "" : uid;
        name = name == null ? "" : name;
        displayName = displayName == null ? "" : displayName;
    }

    /** An anonymous visitor. */
    public static PasskeySubject anonymous() {
        return ANONYMOUS;
    }

    /** Whether this is an anonymous visitor. */
    public boolean isAnonymous() {
        return uid.isEmpty();
    }
}
