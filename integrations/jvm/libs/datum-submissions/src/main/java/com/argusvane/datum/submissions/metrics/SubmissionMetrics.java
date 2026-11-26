package com.argusvane.datum.submissions.metrics;

import com.argusvane.datum.submissions.events.SubmissionRejectedEvent;
import com.argusvane.datum.submissions.events.SubmissionThrottledEvent;
import com.argusvane.datum.submissions.events.SubmissionValidatedEvent;
import com.argusvane.datum.web.monitoring.DatumMeters;
import java.util.Locale;

/**
 * {@code datum.submissions} (tagged {@code form} and {@code status}: {@code accepted} or {@code rejected}) and
 * {@code datum.throttled} (tagged {@code kind}), counted from the receiver's events, so a dry run (which
 * publishes none) never counts. Only forms the receiver found are tagged, so the {@code form} tag is bounded by
 * the forms there are; a throttled request carries no form tag because the route may name a form that does not
 * exist.
 *
 * <p>Framework-free: the host binding hands it the events (Spring through
 * {@code SubmissionMetricsListener}'s {@code @EventListener} methods).
 */
public final class SubmissionMetrics {

    private final DatumMeters meters;

    public SubmissionMetrics(DatumMeters meters) {
        this.meters = meters;
    }

    public void accepted(SubmissionValidatedEvent event) {
        meters.increment("datum.submissions", "form", event.submission().formKey(), "status", "accepted");
    }

    public void rejected(SubmissionRejectedEvent event) {
        meters.increment("datum.submissions", "form", event.formKey() == null ? "unknown" : event.formKey(), "status", "rejected");
    }

    public void throttled(SubmissionThrottledEvent event) {
        meters.increment("datum.throttled", "kind", event.kind().name().toLowerCase(Locale.ROOT));
    }
}
