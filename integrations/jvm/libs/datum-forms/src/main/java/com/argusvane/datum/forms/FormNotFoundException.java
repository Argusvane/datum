package com.argusvane.datum.forms;

import com.argusvane.datum.core.DatumException;

/** No form is stored under the key, or no snapshot under the hash. Maps to 404 {@code form.notFound}. */
public class FormNotFoundException extends DatumException {

    private static final long serialVersionUID = 1L;

    private final String key;

    public FormNotFoundException(String key) {
        super("form.notFound", 404, "There is no form \"" + key + "\".");
        this.key = key;
    }

    public FormNotFoundException(String key, String sha256) {
        super("form.notFound", 404, "There is no version " + sha256 + " of the form \"" + key + "\".");
        this.key = key;
    }

    /** The form key that was asked for. */
    public String key() {
        return key;
    }
}
