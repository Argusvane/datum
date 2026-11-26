package com.argusvane.datum.webauthn.events;

import java.util.Map;

/**
 * A delivered submission's passkey signature was judged (published for real deliveries only, never for a dry
 * run, and only when a signature was present to judge), once per delivery with its final outcome.
 *
 * <p>When: {@code valid} only once the {@code SubmissionHandler} stored the document (the signature check's
 * {@code stored} step, after the receipt and before {@code SubmissionValidatedEvent}), so a handler that fails publishes no
 * valid event and the retry that is stored publishes one. {@code invalid} or {@code unverifiable} when the signature is
 * judged (the delivery ends there), and {@code invalid} for a stale signature (409) and for a use the store refused when it
 * was claimed (a replay that raced, a passkey revoked meanwhile, a counter that moved), before the handler.
 *
 * <p>Delivery: synchronously on the thread that called the submission service, with Spring's default
 * multicaster. A caller inside a transaction (a batch) has the event inside it, before the commit, so a listener that must
 * see the committed record is a {@code @TransactionalEventListener(fallbackExecution = true)}. A listener that throws is
 * logged and never changes the verdict or the answer; it cannot veto.
 *
 * @param formKey the form
 * @param status the verdict's record word: valid, invalid or unverifiable
 * @param credentialId the credential id that signed, or null when the verdict names none
 * @param checks each WebAuthn check by name (see {@code WebAuthnVerifier.REASONS}); empty when none ran
 */
public record SubmissionSignatureVerifiedEvent(String formKey, String status, String credentialId, Map<String, Boolean> checks) {

    public SubmissionSignatureVerifiedEvent {
        checks = checks == null ? Map.of() : Map.copyOf(checks);
    }
}
