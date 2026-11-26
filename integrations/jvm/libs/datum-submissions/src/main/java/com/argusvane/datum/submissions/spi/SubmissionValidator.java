package com.argusvane.datum.submissions.spi;

/**
 * The server stage: the application's own rules over the values the sandbox judged.
 *
 * <p>Every bean runs, in the framework's order (declare {@code @Order} where the relative order matters; equal orders keep registration order), after the sandbox accepted the answers (and after the signature check,
 * when there is one), for deliveries, dry runs ({@link ValidationScope#test()} true) and journey checks alike;
 * all of them run even when an earlier one found errors. A validator that throws stops the request with 503
 * {@code validator_unavailable}: nothing is accepted without the rules the form counts on.
 */
@FunctionalInterface
public interface SubmissionValidator {

    ValidatorResult validate(CandidateSubmission submission);
}
