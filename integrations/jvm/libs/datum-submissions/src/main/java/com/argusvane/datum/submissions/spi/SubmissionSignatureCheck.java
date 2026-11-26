package com.argusvane.datum.submissions.spi;

/**
 * Judges a delivered document's signature. The webauthn module provides it when it is present; with no bean,
 * nothing is judged and every {@link AcceptedSubmission#signature()} is null.
 *
 * <p>{@link #check} runs after the sandbox accepted the answers and before the validators, for deliveries and
 * dry runs (never for a journey check); it must not record anything. {@link #recordUse} runs for a delivery
 * only, after every check passed and just before the {@link SubmissionHandler}: the place to claim the
 * signed digest (replay) and move the passkey's counter. A replay found there throws (a
 * {@link com.argusvane.datum.core.DatumException} with the refusal's code), and the handler is not
 * called.
 *
 * <p>A claimed digest must not outlive a failed store, or a signed document that was never stored could not be sent
 * again. The handler is the application's: when it throws (or answers no receipt) after {@link #recordUse}
 * succeeded, the receiver calls {@link #releaseUse} before the failure goes on, so a signed document that was
 * never stored can be sent again. An implementation whose use and the handler's write share one database may
 * instead join the handler's transaction (and make {@code releaseUse} a no-op).
 *
 * <p>{@link #stored} runs once the handler has stored the document and answered its receipt: the place for
 * anything that must report a stored document only, such as the webauthn module's "valid" signature event (a refusal at
 * {@code recordUse} is reported there, since that delivery ends there). The order for a delivery is {@code check},
 * {@code recordUse}, the handler, then {@code stored} or, when the handler failed, {@code releaseUse}; never both.
 */
public interface SubmissionSignatureCheck {

    SignatureVerdict check(CandidateSubmission submission);

    /** Records the use of an accepted submission's signature; nothing by default. */
    default void recordUse(AcceptedSubmission submission) {
    }

    /**
     * Undoes {@link #recordUse} for a submission the handler did not store; nothing by default. Called at most
     * once, only after {@code recordUse} returned normally; a failure here is logged and does not replace the
     * handler's.
     */
    default void releaseUse(AcceptedSubmission submission) {
    }

    /**
     * Hears that the handler stored {@code submission} under {@code receipt}; nothing by default. Called at
     * most once, only after {@link #recordUse} returned normally and the handler answered a receipt, before
     * {@code SubmissionValidatedEvent}. The document is stored by then, so a failure here (an {@link Exception}, a
     * {@link LinkageError}, an {@link AssertionError}, a {@link StackOverflowError}) is logged and changes neither the
     * answer nor the stored record, and the use is not released.
     */
    default void stored(AcceptedSubmission submission, SubmissionReceipt receipt) {
    }
}
