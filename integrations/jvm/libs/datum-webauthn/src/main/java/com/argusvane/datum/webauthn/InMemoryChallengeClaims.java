package com.argusvane.datum.webauthn;

import java.time.Duration;
import java.time.Instant;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;

/**
 * {@link ChallengeClaims} in this process's memory: single-instance use only. Expired claims are dropped as new
 * ones arrive, so the map holds at most the claims of one challenge lifetime.
 */
public final class InMemoryChallengeClaims implements ChallengeClaims {

    private final Map<String, Instant> claims = new HashMap<>();
    private int sinceSweep;

    @Override
    public synchronized boolean claim(String nonce, Instant now, Duration ttl) {
        if (++sinceSweep >= 1024) {
            sinceSweep = 0;
            for (Iterator<Instant> expiries = claims.values().iterator(); expiries.hasNext(); ) {
                if (!expiries.next().isAfter(now)) {
                    expiries.remove();
                }
            }
        }
        Instant expires = claims.get(nonce);
        if (expires != null && expires.isAfter(now)) {
            return false;
        }
        claims.put(nonce, now.plus(ttl));
        return true;
    }
}
