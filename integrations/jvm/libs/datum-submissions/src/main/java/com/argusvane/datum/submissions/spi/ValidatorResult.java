package com.argusvane.datum.submissions.spi;

import java.util.List;

/**
 * A validator's verdict: errors block the submission (422, stage {@code server}), warnings ride along on the
 * accepted submission and its 200 answer and never block.
 */
public record ValidatorResult(List<SubmissionError> errors, List<SubmissionError> warnings) {

    /** Nothing to say. */
    public static final ValidatorResult OK = new ValidatorResult(List.of(), List.of());

    public ValidatorResult {
        errors = errors == null ? List.of() : List.copyOf(errors);
        warnings = warnings == null ? List.of() : List.copyOf(warnings);
    }

    /** Errors only. */
    public static ValidatorResult errors(SubmissionError... errors) {
        return new ValidatorResult(List.of(errors), List.of());
    }

    /** Warnings only. */
    public static ValidatorResult warnings(SubmissionError... warnings) {
        return new ValidatorResult(List.of(), List.of(warnings));
    }
}
