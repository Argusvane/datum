package com.argusvane.datum.webauthn;

/**
 * The application's per-request policy for making a passkey (the passkey side of the hook model): refuse a
 * registration, limit or replace labels, ask for user verification or a discoverable passkey where the site's policy
 * leaves it open. The beans run in the framework's order (declare {@code @Order} where the relative order matters; equal
 * orders keep registration order), each over what the one before left, at both calls of the ceremony
 * ({@link RegistrationDraft#step()}): before the challenge is issued, and before a posted registration's challenge is
 * claimed (after the body was found readable), so a refused request issues or spends no challenge.
 *
 * <p>A customizer must answer the two steps alike: the options a browser was given are not proof, and the registration
 * step's user verification is the one that is checked.
 *
 * <p>A customizer refuses by throwing {@link com.argusvane.datum.core.hooks.HookRefusedException} (403, 409 or 422
 * with the errors body). Anything else it throws, a draft value outside the policy included, fails the request (500):
 * a passkey made without the policy the application set is not one it meant to accept.
 */
@FunctionalInterface
public interface RegistrationCustomizer {

    /** Adjusts the draft in place, or refuses. */
    void customize(RegistrationDraft draft);
}
