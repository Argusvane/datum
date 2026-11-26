package com.argusvane.datum.timestamp.web;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import org.springframework.context.event.EventListener;

/** Collects the timestamp events the endpoint publishes. */
public class EventLog {

    final List<TimestampIssuedEvent> issued = new CopyOnWriteArrayList<>();
    final List<TimestampRefusedEvent> refused = new CopyOnWriteArrayList<>();

    /** Set: the listeners throw, as a faulty application listener would. */
    volatile boolean failing;

    /** Set: the listener fails an assertion of its own (one guard with the submission's catch set). */
    volatile boolean failingWithError;

    @EventListener
    public void on(TimestampIssuedEvent event) {
        if (failing) {
            throw new IllegalStateException("a listener that fails");
        }
        if (failingWithError) {
            throw new AssertionError("a listener's invariant");
        }
        issued.add(event);
    }

    @EventListener
    public void on(TimestampRefusedEvent event) {
        refused.add(event);
    }
}
