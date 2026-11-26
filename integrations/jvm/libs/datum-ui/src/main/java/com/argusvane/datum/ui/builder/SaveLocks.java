package com.argusvane.datum.ui.builder;

import java.util.concurrent.locks.ReentrantLock;

/**
 * One lock per form key (striped), held around the last re-check and the writes of a builder save.
 *
 * <p>An {@code If-Match} check followed by a write without a lock lets two saves built on the same hash both pass the
 * check (BLD-02 asks that a stale save stores nothing). Here the hash is checked again under the lock right before the
 * repository write,
 * which closes that race inside one JVM; the kernel check runs outside it, so a slow check never holds another
 * author's save. Several instances behind a load balancer can still both pass the check at once, so the hash that
 * was checked is handed to the repository ({@code FormDefinitionRepository#save(definition, expectedSha256)}),
 * where a database repository makes it part of its write.
 */
final class SaveLocks {

    private static final int STRIPES = 64;

    private final ReentrantLock[] locks = new ReentrantLock[STRIPES];

    SaveLocks() {
        for (int i = 0; i < STRIPES; i++) {
            locks[i] = new ReentrantLock();
        }
    }

    /** The lock for a key; every save of the key takes the same one. */
    ReentrantLock of(String key) {
        return locks[Math.floorMod(key.hashCode(), STRIPES)];
    }
}
