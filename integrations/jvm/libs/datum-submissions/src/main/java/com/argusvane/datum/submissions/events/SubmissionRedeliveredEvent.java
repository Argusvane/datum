package com.argusvane.datum.submissions.events;

import com.argusvane.datum.submissions.spi.SubmissionReceipt;

/**
 * A delivery repeated a document that was accepted before ({@code SubmissionIdempotencyStore}): the first receipt
 * was answered with {@code handled: true} and no handler ran, so this is published instead of
 * {@code SubmissionValidatedEvent}. Nothing is stored for the repeat.
 *
 * <p>Delivery: synchronously on the thread that called the service, with Spring's default multicaster.
 * Datum opens no transaction of its own; when the application calls the service inside one (a batch, a queue consumer),
 * the event is published inside it, before the commit, so a listener that must see committed data is a
 * {@code @TransactionalEventListener(fallbackExecution = true)}. A listener that throws is logged and never changes the
 * outcome; it cannot veto (a rule that refuses is a hook: a pre-check, a validator, the handler).
 *
 * @param formKey the form's key
 * @param digest the document's digest
 * @param receipt the receipt the first delivery was given
 * @param channel how the repeat came in ({@code http} for the routes): a document first accepted on one
 *     channel is answered with its first receipt on any other
 */
public record SubmissionRedeliveredEvent(String formKey, String digest, SubmissionReceipt receipt, String channel) {
}
