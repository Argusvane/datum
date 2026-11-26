package com.argusvane.datum.webauthn;

import org.jspecify.annotations.Nullable;

/**
 * Where a form's signing settings come from: configuration, the
 * definition store, or the application's own rules.
 */
@FunctionalInterface
public interface FormSigningSource {

    /** The form's signing settings; {@link FormSigning#OFF} for a form that does not sign. */
    FormSigning forForm(@Nullable String formKey);
}
