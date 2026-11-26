package com.argusvane.datum.forms;

import java.util.Objects;
import tools.jackson.databind.node.ObjectNode;

/**
 * The definition a {@link DefinitionCustomizer} may adjust before it is served to a filler: a copy of the
 * stored definition, never the stored one, adjusted in place, each customizer over what the one before left.
 *
 * <p>The form's identity is not the customizer's: its {@code id} and {@code version} are what a submission names and the
 * receiver checks, so a customizer that changes either fails the request ({@link IllegalStateException}, a 500) rather
 * than serving a page whose submissions would be refused or judged against another form.
 */
public final class DefinitionDraft {

    private final DefinitionRequest request;
    private final ObjectNode definition;

    DefinitionDraft(DefinitionRequest request, ObjectNode definition) {
        this.request = Objects.requireNonNull(request, "request");
        this.definition = Objects.requireNonNull(definition, "definition");
    }

    /** Who it is served to, and which (read only). */
    public DefinitionRequest request() {
        return request;
    }

    /** The definition as it will be served, before the kernel takes out the server-secret rules; change it in place. */
    public ObjectNode definition() {
        return definition;
    }
}
