package com.argusvane.datum.webauthn;

import java.time.Duration;
import java.time.Instant;

/**
 * The claimed nonces of registration challenges: what makes a challenge single-use (the shared SQL's V400
 * {@code datum_passkey_challenge} table: a claim is an insert that fails when the nonce is there already).
 *
 * <p>Implementations must claim atomically across every process that verifies registrations: two requests
 * claiming one nonce at once must see one true. The in-memory one holds only within a process (the decisions'
 * multi-process policy: the starter refuses it unless the application acknowledges single-instance use).
 */
public interface ChallengeClaims {

    /**
     * Claims a nonce.
     *
     * @param nonce the challenge's nonce
     * @param now the server's time
     * @param ttl how long the claim must be remembered (the challenge's lifetime and the clock skew allowed)
     * @return true when this call claimed it; false when it was claimed before and that claim has not expired
     */
    boolean claim(String nonce, Instant now, Duration ttl);
}
