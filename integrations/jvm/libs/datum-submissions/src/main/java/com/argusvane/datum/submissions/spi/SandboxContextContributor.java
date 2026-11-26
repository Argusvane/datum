package com.argusvane.datum.submissions.spi;

/**
 * Adds to a sandbox run's context (external data, a rule module of the application's own). Every bean runs, in the
 * framework's order (declare {@code @Order} where the relative order matters; equal orders keep registration order),
 * after the receiver built the context
 * and before the run; see {@link ContextBuilder} for what stays out of its reach.
 *
 * <p>A contributor that throws stops the request with 503 {@code validator_unavailable}: a run without what it
 * would have added is not the run the form counts on.
 *
 * <p>The second argument is the {@link SubmissionContext}, so the same
 * contributor serves a queue's or a batch's run; its principal, headers and client facts read as the request's did.
 */
@FunctionalInterface
public interface SandboxContextContributor {

    void contribute(ContextBuilder context, SubmissionContext submission);
}
