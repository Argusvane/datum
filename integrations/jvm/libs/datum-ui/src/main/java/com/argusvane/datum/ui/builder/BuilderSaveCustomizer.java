package com.argusvane.datum.ui.builder;

/**
 * Adjusts or refuses a definition about to be saved, before the kernel checks it (the builder side of the hook
 * model): naming rules, metadata, tenant stamping. The beans run in the framework's order (declare {@code @Order} where
 * the relative order matters; equal orders keep registration order), on every save and create of {@link BuilderService}
 * (the routes and any other caller), after the host's own checks (size, precondition, strict JSON, shape, id, language
 * changes, finite numbers) and before the kernel's {@code check}.
 *
 * <p>A customizer refuses by throwing {@link com.argusvane.datum.core.hooks.HookRefusedException}: the save stores
 * nothing and answers {@link BuilderOutcome.Declined} (on the routes, {@code INVALID} is the 422 {@code definition.refused}
 * with the customizer's problems as findings, {@code FORBIDDEN} 403 and {@code CONFLICT} 409 with the errors body).
 * Anything else it throws fails the save (a 500 on the routes), as does changing the form's {@code id}: a definition stored
 * without the adjustment the application counts on is not the one it meant to keep. What the customizers leave is held to
 * the host's shape, finite-number and size rules again (the same refusals as the author's own definition), then the kernel
 * judges it.
 */
@FunctionalInterface
public interface BuilderSaveCustomizer {

    /** Adjusts the draft in place, or refuses. */
    void customize(BuilderSaveDraft draft);
}
