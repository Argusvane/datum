/**
 * Starter: passkey registration and passkey-signed submissions.
 *
 * <p>Brings {@code datum-webauthn} (the ceremony, the verifier, the endpoints under {@code datum.webauthn.path}, the
 * receiver's signature check) and the submissions starter it signs for. Off until {@code datum.webauthn.enabled=true};
 * set {@code datum.webauthn.rp-id}, {@code origins} and {@code secret}, give the application a SQL store (run
 * {@code V400__datum_webauthn.sql}) or acknowledge a single instance with {@code allow-memory-stores}, and name the
 * forms that sign ({@code datum.webauthn.forms.<key>.mode}). The page glue is {@code DatumHost.passkeys()}.
 */
package com.argusvane.datum.starter.webauthn;
