package com.argusvane.datum.forms;

import com.argusvane.datum.core.DatumException;

/**
 * The caller worked from a version of the form (or of its translations) that is no longer current: 409
 * {@code form.outdated} (REC-06; the builder's {@code definition.stale}, BLD-02). {@link #currentSha256()} lets the
 * caller reload the current one.
 */
public class FormOutdatedException extends DatumException {

    private static final long serialVersionUID = 1L;

    private final String currentSha256;

    public FormOutdatedException(String currentSha256) {
        super("form.outdated", 409, "The form changed since it was loaded; reload it and try again.");
        this.currentSha256 = currentSha256;
    }

    /** The hash (or catalog etag) that is current now. */
    public String currentSha256() {
        return currentSha256;
    }
}
