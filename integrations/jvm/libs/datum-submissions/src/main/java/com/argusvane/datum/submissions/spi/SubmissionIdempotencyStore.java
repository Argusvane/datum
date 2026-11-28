package com.argusvane.datum.submissions.spi;

import java.util.Objects;
import java.util.Optional;

/**
 * Remembers which submit attempts a form has already accepted, so that a delivery the browser (or a retrying proxy)
 * repeats is answered with the first receipt and stored once. The key is the form, the form's version and the
 * submission key the browser mints once per submit attempt and sends again on a retry ({@link SubmissionContext#submissionKey()});
 * beside the receipt the store keeps the digest the attempt was accepted with (the canonical-JSON SHA-256 the host and
 * the sandbox program agree on). The key, not the answers, says what one submission is: the same key with the same digest
 * is a retry, answered with the first receipt; the same key with another digest is refused
 * ({@code submission.keyConflict}, 409); two people who give the same answers send two keys and are two submissions.
 *
 * <p>The receiver asks {@link #find} once the form and its version are known and before the document is judged: a known
 * key with the same digest answers the first receipt with {@code handled: true}, runs no sandbox and no handler and
 * publishes {@code SubmissionRedeliveredEvent} instead of {@code SubmissionValidatedEvent}; a known key with another
 * digest is refused, whatever that document holds, and never answered with the first receipt. A first delivery is passed to
 * {@link #remember} after the handler returned. Dry runs and checks never touch the store.
 *
 * <p>Implementations are called from many request threads at once. {@code find} that throws refuses the
 * delivery with 503 (a store that cannot answer must not let a duplicate through unseen); {@code remember}
 * that throws is logged and the delivery is still answered (the record is stored already). Two deliveries of
 * one attempt that overlap in time can both reach the handler; a handler that must be exactly-once keeps its
 * own unique constraint on the form key and {@link AcceptedSubmission#submissionKey()}.
 *
 * <p>The default is bounded and in memory (one process). The SQL store is the host binding's (on Spring Boot,
 * datum-submissions-spring's {@code JdbcSubmissionIdempotencyStore} on Spring's JDBC, chosen by one
 * {@code DataSource} bean or a {@code @Primary} one among several; table {@code datum_submission_digest}, migration
 * {@code V200__datum_submissions.sql}, which this library ships); define your own bean to
 * replace either (the in-memory store starts with a WARN and says so in the
 * health detail {@code idempotency}).
 */
public interface SubmissionIdempotencyStore {

    /**
     * What the store remembers of an accepted attempt.
     *
     * @param digest the digest of the document the attempt was accepted with, lower-case hex
     * @param receipt the receipt its handler gave
     */
    record Remembered(String digest, SubmissionReceipt receipt) {

        public Remembered {
            Objects.requireNonNull(digest, "digest");
            Objects.requireNonNull(receipt, "receipt");
        }
    }

    /**
     * What was remembered for this submit attempt, if it was accepted before.
     *
     * @param formKey the form's key
     * @param version the definition's version string ("" when it has none)
     * @param submissionKey the attempt's submission key
     */
    Optional<Remembered> find(String formKey, String version, String submissionKey);

    /**
     * Keeps the receipt a handler gave for this attempt, with the digest it was accepted with. The first one wins:
     * remembering a key that is already known changes nothing.
     */
    void remember(String formKey, String version, String submissionKey, String digest, SubmissionReceipt receipt);
}
