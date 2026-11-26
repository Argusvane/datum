package com.argusvane.datum.webauthn;

import java.time.Instant;
import java.util.Objects;

/**
 * The digests each passkey's key has signed on this site, and the counter move that goes with a use: the replay
 * guard.
 *
 * <p>Implementations must also keep, with each claim, the counter value {@link #record} replaced, read and
 * written in the same atomic step (in SQL: the row locked or updated with RETURNING in the same transaction), so
 * {@link #release} can put back exactly that.
 *
 * <p>A passkey's assertion signs the hash of a document, with no server nonce, so the same signed
 * document could be posted twice. Each stored signature's digest is kept under the SHA-256 of the key that made
 * it (its SPKI), never under a passkey's id: a key copied from a signature and registered under another
 * credential id is still the same key. Uses outlive the passkey that made them: a key registered again later
 * still cannot sign a digest again.
 *
 * <p>{@link #record} is one atomic step (one transaction in a database store): claim (key, digest) and move the
 * passkey's counter and last use by a conditional update (not revoked; a counting authenticator's counter only
 * goes up, one that keeps none stays 0). When the claim is taken it answers {@link Outcome#REPLAY}; when the
 * update matches no row it gives the claim back and answers {@link Outcome#REVOKED} (revoked, or gone) or
 * {@link Outcome#COUNTER}. Implementations must hold that across every process that accepts submissions.
 */
public interface PasskeyUseStore {

    /** What {@link #record} did. */
    enum Outcome {
        /** Claimed, and the counter moved. */
        RECORDED,
        /** This key signed this digest before. */
        REPLAY,
        /** The passkey was revoked (or deleted) meanwhile. */
        REVOKED,
        /** Its counter moved past this signature's meanwhile. */
        COUNTER
    }

    /**
     * One use of a passkey.
     *
     * @param keySha256 SHA-256 (hex) of the key's SPKI
     * @param digest SHA-256 (hex) of the signed text
     * @param passkeyId the passkey that signed, for the record
     * @param submission the submission stored with it ("" when not known yet)
     * @param signCount the counter the assertion carried
     * @param at when (with the key, the digest, the passkey and the count, what {@link #release} matches the claim by)
     */
    record PasskeyUse(String keySha256, String digest, long passkeyId, String submission, long signCount, Instant at) {

        public PasskeyUse {
            Objects.requireNonNull(keySha256, "keySha256");
            Objects.requireNonNull(digest, "digest");
            submission = submission == null ? "" : submission;
            Objects.requireNonNull(at, "at");
        }
    }

    /** Whether a key has signed this digest before. */
    boolean used(String keySha256, String digest);

    /** Claims the digest and moves the counter, as one step. */
    Outcome record(PasskeyUse use);

    /**
     * Gives back a use {@link #record} recorded, for a submission that was not stored after all (what a rollback of the
     * store's transaction would do): the claim is removed (only this use's, matched by passkey, count and time), and the counter goes
     * back to the value {@link #record} replaced, only while it still is this use's count. Never the counter seen
     * when the signature was judged: another use recorded in between would then be left above the counter, and a
     * copied authenticator could sign again with its count. A use another one followed keeps the
     * counter where the later use put it.
     */
    void release(PasskeyUse use);

    /** How many stored uses name a passkey: whether removing it deletes it or keeps it. */
    long signedCount(long passkeyId);
}
