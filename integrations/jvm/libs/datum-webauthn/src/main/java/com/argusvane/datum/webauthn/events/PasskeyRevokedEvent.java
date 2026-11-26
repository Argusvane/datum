package com.argusvane.datum.webauthn.events;

import java.time.Instant;

/**
 * A passkey was revoked and removed by its owner or an administrator.
 *
 * <p>Delivery: synchronously on the request thread, with Spring's default multicaster, after the
 * repository's write returned; whether that write is committed is the repository's (the JDBC one commits its own), and a
 * caller inside a transaction has the event inside it. A listener that throws is logged and never changes the answer; it
 * cannot veto.
 *
 * @param credentialId the credential id, base64url
 * @param owner who owned it
 * @param by who removed it
 * @param deleted true when the row was deleted; false when it was kept (revoked, its label cleared) because a
 *     stored submission names it, so what it signed can be checked again
 * @param at when
 */
public record PasskeyRevokedEvent(String credentialId, String owner, String by, boolean deleted, Instant at) {
}
