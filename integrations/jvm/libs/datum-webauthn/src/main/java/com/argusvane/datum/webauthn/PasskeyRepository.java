package com.argusvane.datum.webauthn;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import org.jspecify.annotations.Nullable;

/**
 * Where passkeys are kept (the shared SQL's V400 {@code datum_passkey} table, or an application's own store).
 *
 * <p>Rows change by targeted, conditional updates ({@link #revoke}, {@link #markRemoved}, and the counter move
 * {@link PasskeyUseStore#record} makes), never by saving a record read earlier, so a revocation or a higher
 * counter written meanwhile stands.
 */
public interface PasskeyRepository {

    /**
     * The passkey with a credential id, revoked or not; empty for "" or an id longer than 1400 characters.
     * Implementations compare exactly (a SQL store looks up by the SHA-256 of the id, {@link PasskeyRecord#credentialSha256}).
     */
    Optional<PasskeyRecord> find(String credentialId);

    /** The passkey with an id. */
    Optional<PasskeyRecord> findById(long id);

    /** Whether a public key (SHA-256 of its SPKI, hex) is on a passkey here already, revoked or removed included. */
    boolean keyRegistered(String publicKeyHash);

    /**
     * An owner's first passkey in a scope, oldest first, whatever its state: the one whose user handle the next
     * passkey shares. {@code formId} "" is the passkeys that sign any form; else those for that form.
     */
    Optional<PasskeyRecord> firstOf(String owner, String formId);

    /**
     * An owner's passkeys that may sign (not revoked, so not removed), oldest first.
     *
     * @param formId null for all; else those that sign any form and, when it is not "", those for this form
     */
    List<PasskeyRecord> ownActive(String owner, @Nullable String formId);

    /** An owner's passkeys not removed (revoked ones included), oldest first: what their list shows. */
    List<PasskeyRecord> ofOwner(String owner);

    /**
     * Stores a new passkey.
     *
     * @return the record with its id
     * @throws DuplicatePasskeyException when its credential id, or its public key ({@link PasskeyRecord#publicKeyHash}),
     *     is stored already, on any passkey here, revoked or removed ones included. Implementations enforce both
     *     in the store itself (the shared SQL's unique keys on credential_sha256 and public_key_sha256): the ceremony's
     *     look-ups before this call are check-then-act, so two registrations racing must meet here.
     */
    PasskeyRecord create(PasskeyRecord passkey);

    /**
     * The refusal {@link #create} answers when the store itself refuses a value of the passkey (a principal name wider
     * than its column, a public key over the store's limit): {@code passkey.invalid} 422 "The passkey could not be
     * stored.", the person's registration refused, never a server fault (SEC-05: no 5xx but a typed 503). A
     * library factory so every host's store words it the same (the Spring SQL store).
     */
    static PasskeyException unstorable() {
        return new PasskeyException("passkey.invalid", 422, "The passkey could not be stored.", null);
    }

    /**
     * Revokes a passkey, unless it is revoked already (a revocation stays as it was).
     *
     * @return whether it was revoked now
     */
    boolean revoke(long id, String by, Instant at);

    /**
     * Marks a passkey removed by its owner and clears its label, keeping its key, credential id and counter for
     * what it signed (call {@link #revoke} first).
     *
     * @return whether it was marked now
     */
    boolean markRemoved(long id, Instant at);

    /** Deletes a passkey that signed nothing stored ({@link PasskeyUseStore#signedCount} 0). */
    boolean delete(long id);

    /** How long an anonymous passkey that signed nothing is kept unless the host sets its own ({@code datum.webauthn.anonymous-grace}). */
    Duration ANONYMOUS_GRACE = WebAuthnSettings.DEFAULT_ANONYMOUS_GRACE;

    /**
     * Records a successful "Test this passkey" check: when the passkey was last used, and its counter when it went
     * up. The counter only goes up (a counting
     * authenticator) or stays 0 (one that keeps none).
     *
     * @return whether a row was updated
     */
    boolean touch(long id, long signCount, Instant at);

    /**
     * Removes the anonymous passkeys nobody signed with: those of no owner, not made from an invitation, created before {@code before}, that no stored use
     * names. A visitor who registers a passkey and does not send leaves a row with a label that may be one of
     * their answers; it is kept no longer than {@link #ANONYMOUS_GRACE}. The API calls it, bounded, after an
     * anonymous registration, so no scheduler is needed; an application with a retention job may call it there too.
     *
     * <p>The default removes nothing.
     *
     * @param before the cut-off (now minus {@link #ANONYMOUS_GRACE})
     * @param limit the most to remove in one call
     * @return how many were removed
     */
    default int purgeAnonymous(Instant before, int limit) {
        return 0;
    }
}
