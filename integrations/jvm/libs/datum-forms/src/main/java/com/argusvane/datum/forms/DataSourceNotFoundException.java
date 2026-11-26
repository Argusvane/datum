package com.argusvane.datum.forms;

import com.argusvane.datum.core.DatumException;

/** The provider knows no data source under the id. Maps to 404 {@code data_source.notFound}. */
public class DataSourceNotFoundException extends DatumException {

    private static final long serialVersionUID = 1L;

    public DataSourceNotFoundException(String sourceId) {
        super("data_source.notFound", 404, "There is no data source \"" + sourceId + "\".");
    }
}
