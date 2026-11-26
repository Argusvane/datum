package com.argusvane.datum.submissions.events;

import com.argusvane.datum.submissions.spi.AcceptedSubmission;
import com.argusvane.datum.submissions.spi.SubmissionReceipt;

/**
 * A delivery passed every check and the {@code SubmissionHandler} stored it. Published after the handler returned its
 * receipt (and after the signature check's {@code stored} step), so the record exists when it is heard; whether it is
 * committed is the handler's transaction. Never published for a dry run or a journey check.
 *
 * <p>Delivery: synchronously on the thread that called the service, with Spring's default multicaster.
 * Datum opens no transaction of its own; when the application calls the service inside one (a batch, a queue consumer),
 * the event is published inside it, before the commit, so a listener that must see committed data is a
 * {@code @TransactionalEventListener(fallbackExecution = true)}. A listener that throws is logged and never changes the
 * outcome; it cannot veto (a rule that refuses is a hook: a pre-check, a validator, the handler).
 */
public record SubmissionValidatedEvent(AcceptedSubmission submission, SubmissionReceipt receipt) {

    /** How the document came in: the accepted submission's {@link AcceptedSubmission#channel()}. */
    public String channel() {
        return submission.channel();
    }
}
