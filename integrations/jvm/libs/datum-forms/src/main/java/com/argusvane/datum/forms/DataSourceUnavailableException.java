package com.argusvane.datum.forms;

import com.argusvane.datum.core.DatumException;

/**
 * A data source could not answer in time, or failed. A submission is never judged against a source that
 * could not answer (its options would be missing from the snapshot, so a valid answer would be refused), so this maps
 * to 503 {@code data_source.unavailable}. The message names the source id only, never what the provider threw.
 */
public class DataSourceUnavailableException extends DatumException {

    private static final long serialVersionUID = 1L;

    private final String sourceId;

    public DataSourceUnavailableException(String sourceId, Throwable cause) {
        super("data_source.unavailable", 503, "The data source \"" + sourceId + "\" is not available right now.", cause);
        this.sourceId = sourceId;
    }

    /** The data source that could not answer. */
    public String sourceId() {
        return sourceId;
    }
}
