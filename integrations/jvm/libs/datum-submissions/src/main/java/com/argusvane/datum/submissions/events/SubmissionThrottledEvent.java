package com.argusvane.datum.submissions.events;

import com.argusvane.datum.submissions.spi.ThrottleKey;
import java.time.Duration;

/**
 * A request was refused by the throttle (429), before anything was judged: by the address limit, before its body was
 * read (the key names only the counted address and the route's kind), or by the per-form throttle after the parse.
 * Published for every mode but a dry run, just before the 429 is answered.
 *
 * <p>Delivery: synchronously on the thread that called the service, with Spring's default multicaster.
 * Datum opens no transaction of its own; when the application calls the service inside one (a batch, a queue consumer),
 * the event is published inside it, before the commit, so a listener that must see committed data is a
 * {@code @TransactionalEventListener(fallbackExecution = true)}. A listener that throws is logged and never changes the
 * outcome; it cannot veto (a rule that refuses is a hook: a pre-check, a validator, the handler).
 *
 * @param key who asked
 * @param kind which route ({@code key.kind()})
 * @param retryAfter how long the key waits
 * @param channel how the request came in ({@code key.channel()})
 */
public record SubmissionThrottledEvent(ThrottleKey key, ThrottleKey.Kind kind, Duration retryAfter, String channel) {
}
