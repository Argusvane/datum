package com.argusvane.datum.forms;

import java.security.Principal;
import java.util.Locale;
import java.util.Objects;

/**
 * Who a public definition is about to be served to, and which: what a {@link DefinitionCustomizer} reads to
 * decide its adjustment and its cache key. Read only.
 *
 * @param formKey the form
 * @param sha256 the hash of the stored definition being served (the version a submission names)
 * @param current whether it is the current definition (false: a version asked for by its hash)
 * @param principal who asks, or null (an anonymous filler, or a caller outside a request)
 * @param locale the request's locale as the web framework resolved it, or null when it resolved none
 */
public record DefinitionRequest(String formKey, String sha256, boolean current, Principal principal, Locale locale) {

    public DefinitionRequest {
        Objects.requireNonNull(formKey, "formKey");
        Objects.requireNonNull(sha256, "sha256");
    }
}
