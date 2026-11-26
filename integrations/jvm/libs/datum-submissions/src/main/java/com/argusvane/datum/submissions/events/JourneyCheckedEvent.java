package com.argusvane.datum.submissions.events;

/**
 * A journey's page or final check was answered, accepted or not. Published before the 200
 * answer; nothing is stored.
 *
 * <p>Delivery: synchronously on the thread that called the service, with Spring's default multicaster.
 * Datum opens no transaction of its own; when the application calls the service inside one (a batch, a queue consumer),
 * the event is published inside it, before the commit, so a listener that must see committed data is a
 * {@code @TransactionalEventListener(fallbackExecution = true)}. A listener that throws is logged and never changes the
 * outcome; it cannot veto (a rule that refuses is a hook: a pre-check, a validator, the handler).
 *
 * @param formKey the form
 * @param journeyId the journey judged by, or null when the check named an unknown one
 * @param pageId the page checked, or null for a whole-journey check
 * @param accepted whether nothing in scope blocks
 * @param channel how the check came in ({@code http} for the route)
 */
public record JourneyCheckedEvent(String formKey, String journeyId, String pageId, boolean accepted, String channel) {
}
