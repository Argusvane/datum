package com.argusvane.datum.web.error;

import com.argusvane.datum.core.DatumException;

/** A JSON endpoint was sent another Content-Type: 415 {@code unsupported_media_type} (conformance suite REC-15). */
public class UnsupportedMediaTypeException extends DatumException {

    private static final long serialVersionUID = 1L;

    public static final String CODE = "unsupported_media_type";

    public UnsupportedMediaTypeException() {
        super(CODE, 415, "Send the body as JSON (Content-Type: application/json).");
    }
}
