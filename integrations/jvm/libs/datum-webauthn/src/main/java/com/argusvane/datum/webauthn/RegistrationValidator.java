package com.argusvane.datum.webauthn;

import com.argusvane.datum.core.hooks.HookProblem;
import java.util.List;

/**
 * The application's own judgement of a passkey the ceremony verified, before it is stored (the passkey side of
 * the hook model): an AAGUID allow-list, an attestation-format policy, a backup-state rule. Every bean runs, in the
 * framework's order (declare {@code @Order} where the relative order matters; equal orders keep registration order), after
 * every WebAuthn check passed and after the credential id and the key were found new (so Datum's own refusals, 400, 422
 * and 409, come first), and all of them run even when an earlier one found errors.
 *
 * <p>Errors refuse: nothing is stored, and the request answers
 * {@link com.argusvane.datum.core.hooks.HookRefusedException} {@code INVALID} with every error in order (422 with
 * the errors body; its code is the first error's). A validator may throw {@code HookRefusedException} to refuse at once with
 * another kind (403, 409); anything else it throws fails the request (500). There are no warnings: a registration's answer
 * has no place for them.
 */
@FunctionalInterface
public interface RegistrationValidator {

    /**
     * @param context what the passkey was made for
     * @param asking who made it
     * @param passkey the passkey as it will be stored: its AAGUID, attestation format, algorithm, flags, transports, label
     * @return the errors; empty to let it be stored
     */
    List<HookProblem> validate(PasskeyContext context, PasskeySubject asking, PasskeyRecord passkey);
}
