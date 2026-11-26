package com.argusvane.datum.ui.builder;

import java.security.Principal;
import java.util.Objects;
import tools.jackson.databind.node.ObjectNode;

/**
 * The definition a {@link BuilderSaveCustomizer} may adjust before the kernel checks it: a copy of what the
 * author sent, after the host's own shape rules held, adjusted in place, each customizer over what the one before left.
 * What they leave is held to the same host rules again, then checked by the kernel and stored: the stored definition is
 * the customized one, and the answer's hash (the next {@code If-Match}) names it.
 *
 * <p>The form's {@code id} is not the customizer's: it is the form's key and what every submission names, so a
 * customizer that changes it fails the save ({@link IllegalStateException}, a 500) rather than storing the definition
 * under another form's name.
 */
public final class BuilderSaveDraft {

    private final String key;
    private final boolean creating;
    private final Principal principal;
    private final ObjectNode definition;

    BuilderSaveDraft(String key, boolean creating, Principal principal, ObjectNode definition) {
        this.key = Objects.requireNonNull(key, "key");
        this.creating = creating;
        this.principal = principal;
        this.definition = Objects.requireNonNull(definition, "definition");
    }

    /** The form (read only). */
    public String key() {
        return key;
    }

    /** Whether this is a create rather than a save of an existing form (read only). */
    public boolean creating() {
        return creating;
    }

    /** Who saves, or null (read only). */
    public Principal principal() {
        return principal;
    }

    /** The definition about to be checked and stored; change it in place. */
    public ObjectNode definition() {
        return definition;
    }
}
