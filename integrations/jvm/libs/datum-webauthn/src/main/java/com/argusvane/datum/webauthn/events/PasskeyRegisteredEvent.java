package com.argusvane.datum.webauthn.events;

import java.time.Instant;

/**
 * A passkey was registered. Never carries the passkey's name, which may be an answer (a person's name): the
 * credential id identifies it.
 *
 * <p>Delivery: synchronously on the request thread, with Spring's default multicaster, after the
 * repository's write returned; whether that write is committed is the repository's (the JDBC one commits its own), and a
 * caller inside a transaction has the event inside it. A listener that throws is logged and never changes the answer; it
 * cannot veto.
 *
 * @param credentialId the credential id, base64url
 * @param owner who owns it ("" for a visitor's)
 * @param formKey the form it was made through ("" when made ahead of time on an account)
 * @param origin how it was made: form or account
 * @param at when
 */
public record PasskeyRegisteredEvent(String credentialId, String owner, String formKey, String origin, Instant at) {
}
