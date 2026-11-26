package com.argusvane.datum.webauthn;

/**
 * The application's per-form policy for checking a submission's passkey signature (the signing side of the
 * hook model): refuse a signature by who signed or with which passkey, or check it more strictly for one
 * form (user verification required, a shorter signing window) than the form's settings say. The beans run in the
 * framework's order (declare {@code @Order} where the relative order matters; equal orders keep registration order),
 * each over what the one before left and never looser than it (the draft only tightens, so a later hook cannot undo an
 * earlier one's stricter setting).
 *
 * <p>Where: {@link SubmissionSignatureVerifier}'s step 9, before the assertion is verified. Every refusal of the steps
 * before it comes first (no passkey signature, more than one, passkeys not set up, the format, the statement or scope,
 * the signed text, a passkey that is unknown, revoked, another form's or another account's, another user handle), so a
 * customizer sees a registered passkey that may sign this form, and only for a signature this site judges (never a
 * visitor's while visitors may not sign: that is {@code signature.sign_in}). The replay guard, the counter and the
 * signing window still follow the assertion, the window as the draft leaves it.
 *
 * <p>A customizer refuses by throwing {@link com.argusvane.datum.core.hooks.HookRefusedException}: the submission
 * answers it (403, 409 or 422 with the errors body) on every channel, a dry run included, and nothing is recorded.
 * Anything else it throws, a draft value weaker than the form's policy included, fails the request: a signature checked
 * without the policy the application set is not one it meant to accept.
 */
@FunctionalInterface
public interface SignatureCheckCustomizer {

    /** Adjusts the draft in place, or refuses. */
    void customize(SignatureCheckDraft draft);
}
