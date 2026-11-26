package com.argusvane.datum.webauthn.submissions;

import com.argusvane.datum.core.DatumEventPublisher;
import com.argusvane.datum.core.DatumException;
import com.argusvane.datum.submissions.spi.AcceptedSubmission;
import com.argusvane.datum.submissions.spi.CandidateSubmission;
import com.argusvane.datum.submissions.spi.SignatureVerdict;
import com.argusvane.datum.submissions.spi.SubmissionMode;
import com.argusvane.datum.submissions.spi.SubmissionReceipt;
import com.argusvane.datum.submissions.spi.SubmissionSignatureCheck;
import com.argusvane.datum.webauthn.events.SubmissionSignatureVerifiedEvent;
import com.argusvane.datum.webauthn.submissions.PasskeySignatureCheck;
import java.util.Map;
import java.util.Objects;

/**
 * The receiver's {@link SubmissionSignatureCheck}: {@link PasskeySignatureCheck} (the verifier, its policy and
 * words), plus a {@link SubmissionSignatureVerifiedEvent} for each real delivery that carried a
 * signature to judge. Through the host's default publisher ({@link DatumEventPublisher#guarded}) a listener
 * that throws is logged and changes nothing: the verdict is the check's. An application's own publisher is used as given,
 * and one that throws reaches the caller.
 *
 * <p>The event states the final outcome, so an audit listener never reads "valid" for a delivery that was then
 * refused or not stored. A signature that is not valid is published when it is judged (the delivery ends there), and so
 * is one refused as stale (409), which {@link PasskeySignatureCheck#check} throws. A use the store refuses at
 * {@link #recordUse} (a replay that raced: two identical signed deliveries both pass {@code check} and the one that loses
 * the claim; a passkey revoked meanwhile; a counter that moved) is published as {@code invalid} there, since that
 * delivery ends there. A valid one is published from {@link #stored}, once the handler has stored the document (never at {@code recordUse},
 * before the handler): a handler that fails has
 * the use given back through {@link #releaseUse} and publishes nothing, so the client's retry that is stored is the one
 * valid event. One event per delivery that ends with a signature verdict, and a valid one only for a stored document.
 */
public final class PublishingSignatureCheck implements SubmissionSignatureCheck {

    private final PasskeySignatureCheck delegate;
    private final DatumEventPublisher events;

    public PublishingSignatureCheck(PasskeySignatureCheck delegate, DatumEventPublisher events) {
        this.delegate = Objects.requireNonNull(delegate, "delegate");
        // As given: the host guards its default publisher; an application's own owns its failures.
        this.events = Objects.requireNonNull(events, "events");
    }

    @Override
    public SignatureVerdict check(CandidateSubmission submission) {
        SignatureVerdict verdict;
        try {
            verdict = delegate.check(submission);
        } catch (DatumException e) {
            if (submission.mode() == SubmissionMode.SUBMIT && "signature.stale".equals(e.code())) {
                publish(submission.formKey(), "invalid", Map.of());
            }
            throw e;
        }
        if (submission.mode() == SubmissionMode.SUBMIT && verdict.status() != SignatureVerdict.Status.VALID) {
            publish(submission.formKey(), verdict.details());
        }
        return verdict;
    }

    @Override
    public void recordUse(AcceptedSubmission submission) {
        try {
            delegate.recordUse(submission);
        } catch (DatumException e) {
            // The claim was refused (a replay that raced, a passkey revoked meanwhile, a counter that moved).
            if (submission.signature() != null && submission.signature().status() == SignatureVerdict.Status.VALID) {
                Map<String, Object> refused = new java.util.LinkedHashMap<>(submission.signature().details());
                refused.put("status", "invalid");
                publish(submission.formKey(), refused);
            }
            throw e;
        }
    }

    @Override
    public void releaseUse(AcceptedSubmission submission) {
        delegate.releaseUse(submission);
    }

    /** The document is stored: a valid signature is published now, its final outcome. */
    @Override
    public void stored(AcceptedSubmission submission, SubmissionReceipt receipt) {
        delegate.stored(submission, receipt);
        if (submission.signature() != null && submission.signature().status() == SignatureVerdict.Status.VALID) {
            publish(submission.formKey(), submission.signature().details());
        }
    }

    private void publish(String formKey, Map<String, Object> details) {
        Object status = details.get("status");
        if (status instanceof String word && (word.equals("valid") || word.equals("invalid") || word.equals("unverifiable"))) {
            Object credential = details.get("credentialId");
            Object checks = details.get("checks");
            @SuppressWarnings("unchecked")
            Map<String, Boolean> checkMap = checks instanceof Map<?, ?> ? (Map<String, Boolean>) checks : Map.of();
            publish(formKey, word, credential instanceof String id ? id : null, checkMap);
        }
    }

    private void publish(String formKey, String status, Map<String, Boolean> checks) {
        publish(formKey, status, null, checks);
    }

    private void publish(String formKey, String status, String credentialId, Map<String, Boolean> checks) {
        events.publish(new SubmissionSignatureVerifiedEvent(formKey, status, credentialId, checks));
    }
}
