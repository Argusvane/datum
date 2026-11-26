package com.argusvane.datum.web.openapi;

/** Media types and header names the Datum endpoints share. */
public final class DatumMediaTypes {

    /** RFC 3161 request body (the timestamp authority endpoint). */
    public static final String TIMESTAMP_QUERY = "application/timestamp-query";

    /** RFC 3161 response body. */
    public static final String TIMESTAMP_REPLY = "application/timestamp-reply";

    /** A PDF answer; carries {@link #PAGE_COUNT_HEADER}. */
    public static final String PDF = "application/pdf";

    public static final String PAGE_COUNT_HEADER = "X-Page-Count";

    /** The locales a builder save removed (comma separated); the translations write answers it. */
    public static final String REMOVED_LOCALES_HEADER = "X-Datum-Removed-Locales";

    private DatumMediaTypes() {
    }
}
