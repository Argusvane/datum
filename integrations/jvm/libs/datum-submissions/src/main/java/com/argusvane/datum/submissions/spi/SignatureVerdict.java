package com.argusvane.datum.submissions.spi;

import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;

/**
 * A {@link SubmissionSignatureCheck}'s verdict on a delivered document's signature.
 *
 * <p>The receiver refuses the submission (422, stage {@code signature}) when {@link #errors()} is not empty,
 * with those entries as the answer's errors: the check decides the policy (a required signature that is absent,
 * an unverifiable one on a form that verifies on arrival) and carries the wire's codes ({@code signature.required},
 * {@code signature.invalid}, ...). A status of {@link Status#INVALID} always refuses, with or without errors: a
 * signature found invalid is never accepted because its checker forgot to say why (an invalid or
 * required-but-absent signature is a 422); with no errors the answer carries one {@code signature.invalid}. Any other verdict
 * without errors is kept on the {@link AcceptedSubmission}.
 *
 * @param status what was found
 * @param errors why the submission is refused; empty to accept it
 * @param details what the check wants kept beside the record (credential id, checks, signedAt); copied
 */
public record SignatureVerdict(Status status, List<SubmissionError> errors, Map<String, Object> details) {

    /** What was found. */
    public enum Status {
        VALID,
        INVALID,
        UNVERIFIABLE,
        ABSENT;

        /** The wire word: {@code valid}, {@code invalid}, {@code unverifiable}, {@code absent}. */
        public String wire() {
            return name().toLowerCase(Locale.ROOT);
        }
    }

    public SignatureVerdict {
        Objects.requireNonNull(status, "status");
        errors = errors == null ? List.of() : List.copyOf(errors);
        details = details == null ? Map.of() : Map.copyOf(details);
    }

    /** No signature, and none needed. */
    public static SignatureVerdict absent() {
        return new SignatureVerdict(Status.ABSENT, List.of(), Map.of());
    }

    /** Whether the receiver refuses the submission for it: an invalid signature, or any error. */
    public boolean refuses() {
        return status == Status.INVALID || !errors.isEmpty();
    }

    /** The errors a refusal answers with: {@link #errors()}, or one {@code signature.invalid} when none were given. */
    public List<SubmissionError> refusalErrors() {
        if (!errors.isEmpty() || !refuses()) {
            return errors;
        }
        return List.of(SubmissionError.error(null, "signature.invalid", null));
    }
}
