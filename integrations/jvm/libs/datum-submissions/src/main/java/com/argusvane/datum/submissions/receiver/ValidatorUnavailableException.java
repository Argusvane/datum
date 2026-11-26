package com.argusvane.datum.submissions.receiver;

import com.argusvane.datum.core.DatumException;

/**
 * The verdict could not be reached for a reason that is not the answers': a server validator or context
 * contributor threw, or the program's outcome lacks what a record is stored under (503 {@code validator_unavailable},
 * REC-16). Nothing is accepted; the message is for the log, the answer carries none.
 */
public class ValidatorUnavailableException extends DatumException {

    private static final long serialVersionUID = 1L;

    public static final String CODE = "validator_unavailable";

    public ValidatorUnavailableException(String message) {
        super(CODE, 503, message);
    }

    public ValidatorUnavailableException(String message, Throwable cause) {
        super(CODE, 503, message, cause);
    }
}
