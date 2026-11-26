package com.argusvane.datum.submissions.events;

import com.argusvane.datum.submissions.spi.SubmissionError;
import java.util.List;

/**
 * A delivery was refused for its content: 422 at one stage, published synchronously just before the answer.
 * Never published for a dry run, a journey check, or a refusal that is not about the answers (400, 403, 409,
 * 413, 415, 429, 503). Nothing is stored.
 *
 * <p>Delivery: synchronously on the thread that called the service, with Spring's default multicaster.
 * Datum opens no transaction of its own; when the application calls the service inside one (a batch, a queue consumer),
 * the event is published inside it, before the commit, so a listener that must see committed data is a
 * {@code @TransactionalEventListener(fallbackExecution = true)}. A listener that throws is logged and never changes the
 * outcome; it cannot veto (a rule that refuses is a hook: a pre-check, a validator, the handler).
 *
 * @param formKey the form
 * @param errors the answer's errors
 * @param stage {@code journey} (an unknown or missing journey), {@code sandbox}, {@code signature} or
 *     {@code server} (a validator)
 * @param remoteAddress the client address, or null (always there on the HTTP routes, optional on another channel)
 * @param channel how the document came in ({@code http} for the routes)
 */
public record SubmissionRejectedEvent(String formKey, List<SubmissionError> errors, String stage, String remoteAddress, String channel) {

    public SubmissionRejectedEvent {
        errors = errors == null ? List.of() : List.copyOf(errors);
    }
}
