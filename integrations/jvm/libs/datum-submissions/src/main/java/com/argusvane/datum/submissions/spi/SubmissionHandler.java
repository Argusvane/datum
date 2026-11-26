package com.argusvane.datum.submissions.spi;

/**
 * Keeps an accepted submission: the application's storage step. The packages store nothing themselves:
 * the default {@code LoggingSubmissionHandler} only logs and answers a fresh id.
 *
 * <p>Called in the request thread after every check passed (sandbox, signature, validators), exactly once per
 * accepted delivery, never for a dry run or a check. An exception stops the request: a
 * {@link com.argusvane.datum.core.DatumException} answers with its own code and status, anything
 * else is a 500 with a correlation id. A handler that writes to a database usually wraps its work in a
 * transaction.
 */
@FunctionalInterface
public interface SubmissionHandler {

    /**
     * Stores the submission.
     *
     * @return the receipt the browser is answered with; never null
     */
    SubmissionReceipt handle(AcceptedSubmission submission);
}
