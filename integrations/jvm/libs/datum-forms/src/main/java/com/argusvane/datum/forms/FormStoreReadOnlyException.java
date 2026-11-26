package com.argusvane.datum.forms;

import com.argusvane.datum.core.DatumException;

/**
 * The configured {@link FormDefinitionRepository} cannot save (the resource repository is read-only).
 * Maps to 501 {@code forms.readOnly}: the builder's write endpoints need an application repository.
 */
public class FormStoreReadOnlyException extends DatumException {

    private static final long serialVersionUID = 1L;

    public FormStoreReadOnlyException() {
        super("forms.readOnly", 501, "Forms are read from resources and cannot be saved. Provide a FormDefinitionRepository bean to store them.");
    }
}
