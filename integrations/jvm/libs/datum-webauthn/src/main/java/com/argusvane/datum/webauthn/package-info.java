/**
 * Datum WebAuthn: the passkey registration ceremony and passkey-signed submissions, over webauthn4j.
 *
 * <p>This package is the library: {@link com.argusvane.datum.webauthn.WebAuthnVerifier} (the
 * relying party's checks, webauthn4j as a second gate), {@link com.argusvane.datum.webauthn.SignedText}
 * (scope, statement, JCS, SHA-256), {@link com.argusvane.datum.webauthn.PasskeyChallenges}
 * (signed single-use registration challenges), {@link com.argusvane.datum.webauthn.RegistrationCeremony},
 * {@link com.argusvane.datum.webauthn.SubmissionSignatureVerifier} and the SPIs with their in-memory
 * implementations. It imports no Spring type. {@code .submissions} is the receiver seam (datum-submissions
 * optional); {@code .web} and {@code .spring} are the endpoints and auto-configuration.
 *
 * <p>Nullability: the package is {@code @NullMarked}, so a type with no annotation is
 * non-null and {@code @Nullable} marks the places a null is meant (an anonymous caller, a verdict's reason when it passed, a
 * per-form setting left to the site's value).
 */
@NullMarked
package com.argusvane.datum.webauthn;

import org.jspecify.annotations.NullMarked;
