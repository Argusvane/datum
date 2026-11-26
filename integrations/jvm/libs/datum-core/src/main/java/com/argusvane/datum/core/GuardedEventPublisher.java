package com.argusvane.datum.core;

import java.util.Objects;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The one guard over Datum's publications (every call site shares this one catch set): a listener that fails is logged at ERROR under {@code datum.events}, with the event's type and the
 * failure, and the code that published goes on. The catch set is the one the submission service had, so it holds for
 * every event: any {@link Exception} (a checked one thrown sneakily too), a {@link LinkageError} (a listener built
 * against another version), an {@link AssertionError} (a listener's own invariant) and a {@link StackOverflowError} (a
 * listener's recursion, which unwinds to here with the stack free again). Every other {@link Error}, an
 * {@code OutOfMemoryError} first, is the JVM's state rather than the listener's, and goes on to the caller.
 */
final class GuardedEventPublisher implements DatumEventPublisher {

    private static final Logger LOG = LoggerFactory.getLogger("datum.events");

    private final DatumEventPublisher delegate;

    GuardedEventPublisher(DatumEventPublisher delegate) {
        this.delegate = Objects.requireNonNull(delegate, "delegate");
    }

    @Override
    public void publish(Object event) {
        try {
            delegate.publish(event);
        } catch (Exception | LinkageError | AssertionError | StackOverflowError e) {
            // The effect the event reports has happened (the submission stored, the PDF made, the token issued): a
            // listener's failure is the listener's, never the request's.
            LOG.error("A listener of {} failed; Datum's answer is unchanged.", event == null ? "null" : event.getClass().getSimpleName(), e);
        }
    }
}
