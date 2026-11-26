package com.argusvane.datum.forms;

import java.util.Optional;

/**
 * Adjusts the definition about to be served to a filler (the forms side of the hook model): per-tenant
 * defaults, components hidden for a principal, a label for a locale. The beans run in the framework's order (declare
 * {@code @Order} where the relative order matters; equal orders keep registration order), each over what the one before
 * left, on the PUBLIC copy's way out: {@code GET /forms/{key}/definition} with no {@code public} parameter or
 * {@code public=true}, current or by hash, and {@link DefinitionService#currentPublic}/{@link DefinitionService#publicSnapshot}.
 *
 * <p>In order: the customizers run over a copy of the stored definition, then the kernel makes the public copy of what
 * they left (so a server-secret rule never reaches a filler, whoever added it), then the representation's hash is the
 * {@code ETag}. Never customized: the author's copy ({@code public=false}), whose {@code ETag} the builder's
 * {@code If-Match} names, and the definition a submission is judged against, which is the stored one: a customizer that
 * hides a required component must make the submission side agree (a {@code SandboxContextContributor} or the form
 * itself), or the hidden answer is refused.
 *
 * <p>A customizer refuses by throwing {@link com.argusvane.datum.core.hooks.HookRefusedException} (403, 409 or 422
 * with the errors body); anything else it throws fails the request (500), as does changing the form's {@code id} or
 * {@code version}: a definition served without the adjustment the application counts on (a hidden component) could show
 * what it hides.
 *
 * <p>The public copy is cached: by the stored definition's hash while no customizer exists; with customizers, by that
 * hash and every customizer's {@link #cacheKey}, or not at all when one of them declares none. With customizers, the
 * {@code datum.forms.cache.snapshot} header is never used: every answer carries {@code datum.forms.cache.definition}
 * (no-store by default), since a shared cache cannot tell one principal's copy from another's.
 */
@FunctionalInterface
public interface DefinitionCustomizer {

    /** Adjusts the draft in place, or refuses. */
    void customize(DefinitionDraft draft);

    /**
     * The variant of the definition this customizer makes for a request ({@code "tenant:acme"}, a locale tag), so the
     * kernel's public copy of the customized definition is cached per stored hash and key, or empty when what it makes
     * must not be cached (the public copy is then made for every request, a sandbox run each for a form with server-secret
     * rules). The key must name everything the adjustment depends on: a request whose customized definition differs from
     * the one cached under the same key is answered from a fresh copy and not cached, with a WARN.
     *
     * <p>Asked before {@link #customize}. Default: empty (never cached).
     */
    default Optional<String> cacheKey(DefinitionRequest request) {
        return Optional.empty();
    }
}
