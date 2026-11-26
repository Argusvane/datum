package com.argusvane.datum.ui.builder;

import com.argusvane.datum.core.hooks.HookFindings;

/**
 * The application's own judgement of a definition after the kernel accepted it and before it is stored (the
 * builder side of the hook model). Every bean runs, in the framework's order (declare {@code @Order} where the relative
 * order matters; equal orders keep registration order), and all of them run even when an earlier one found errors, so the
 * author sees every problem at once.
 *
 * <p>Errors refuse the save: nothing is stored and the outcome is {@link BuilderOutcome.Declined} with every validator's
 * errors in order (on the routes the 422 {@code definition.refused}, each error a finding under the author's boxes: its
 * field is the {@code where}). Warnings ride along with a stored definition, after the kernel's, in
 * {@link BuilderOutcome.Saved#warnings()}. A validator may also throw
 * {@link com.argusvane.datum.core.hooks.HookRefusedException} to refuse at once with another kind (403, 409);
 * anything else it throws fails the save (a 500 on the routes).
 */
@FunctionalInterface
public interface BuilderSaveValidator {

    /** What the validator finds; {@link HookFindings#NONE} to let the save go on. */
    HookFindings validate(BuilderSaveCandidate candidate);
}
