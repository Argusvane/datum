package com.argusvane.datum.ui.builder;

import com.argusvane.datum.forms.DefinitionVerdict;
import java.security.Principal;
import java.util.Objects;
import tools.jackson.databind.node.ObjectNode;

/**
 * A definition the kernel accepted, about to be stored: what a {@link BuilderSaveValidator} sees. Read only:
 * the definition is a copy, so a validator changes nothing of what is stored.
 *
 * @param key the form
 * @param creating whether this is a create
 * @param principal who saves, or null
 * @param definition a copy of the definition as it will be stored (after the customizers)
 * @param verdict the kernel's verdict: accepted, with its structure warnings
 */
public record BuilderSaveCandidate(String key, boolean creating, Principal principal, ObjectNode definition, DefinitionVerdict verdict) {

    public BuilderSaveCandidate {
        Objects.requireNonNull(key, "key");
        Objects.requireNonNull(definition, "definition");
        Objects.requireNonNull(verdict, "verdict");
    }
}
