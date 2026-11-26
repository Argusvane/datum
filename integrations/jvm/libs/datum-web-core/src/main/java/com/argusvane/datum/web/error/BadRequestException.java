package com.argusvane.datum.web.error;

import com.argusvane.datum.core.DatumException;

/**
 * A request body that is not usable JSON (not JSON, too deep, a number outside range): 400, code
 * {@code bad_document} (conformance suite REC-01, REC-02, REC-04).
 */
public class BadRequestException extends DatumException {

    private static final long serialVersionUID = 1L;

    public static final String BAD_DOCUMENT = "bad_document";

    public BadRequestException(String message) {
        super(BAD_DOCUMENT, 400, message);
    }

    public BadRequestException(String code, String message) {
        super(code, 400, message);
    }

    public BadRequestException(String message, Throwable cause) {
        super(BAD_DOCUMENT, 400, message, cause);
    }
}
