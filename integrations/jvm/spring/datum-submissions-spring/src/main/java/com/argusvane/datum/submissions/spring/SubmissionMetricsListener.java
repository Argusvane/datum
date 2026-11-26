package com.argusvane.datum.submissions.spring;

import com.argusvane.datum.submissions.events.SubmissionRejectedEvent;
import com.argusvane.datum.submissions.events.SubmissionThrottledEvent;
import com.argusvane.datum.submissions.events.SubmissionValidatedEvent;
import com.argusvane.datum.submissions.metrics.SubmissionMetrics;
import org.springframework.context.event.EventListener;

/** Hands the receiver's application events to the library's {@link SubmissionMetrics}. */
public final class SubmissionMetricsListener {

    private final SubmissionMetrics metrics;

    public SubmissionMetricsListener(SubmissionMetrics metrics) {
        this.metrics = metrics;
    }

    @EventListener
    public void accepted(SubmissionValidatedEvent event) {
        metrics.accepted(event);
    }

    @EventListener
    public void rejected(SubmissionRejectedEvent event) {
        metrics.rejected(event);
    }

    @EventListener
    public void throttled(SubmissionThrottledEvent event) {
        metrics.throttled(event);
    }
}
