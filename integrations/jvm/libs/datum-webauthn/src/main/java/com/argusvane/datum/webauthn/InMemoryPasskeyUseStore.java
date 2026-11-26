package com.argusvane.datum.webauthn;

import java.util.HashMap;
import java.util.Map;
import java.util.Objects;

/**
 * {@link PasskeyUseStore} in this process's memory, over an {@link InMemoryPasskeyRepository}: single-instance
 * use and tests. Uses are kept for ever (they outlive their passkeys, as the shared SQL's rows do: a replay guard must
 * outlive the key it guards).
 */
public final class InMemoryPasskeyUseStore implements PasskeyUseStore {

    private final InMemoryPasskeyRepository passkeys;
    private final Map<String, Held> uses = new HashMap<>();

    /** A claim, with the counter its counter move replaced (what a release puts back). */
    private record Held(PasskeyUse use, long replaced) {
    }

    public InMemoryPasskeyUseStore(InMemoryPasskeyRepository passkeys) {
        this.passkeys = Objects.requireNonNull(passkeys, "passkeys");
        // So the repository's purge of anonymous passkeys keeps every one a stored use names.
        passkeys.usesBy(id -> signedCount(id) > 0);
    }

    private static String key(String keySha256, String digest) {
        return keySha256 + "|" + digest;
    }

    @Override
    public boolean used(String keySha256, String digest) {
        synchronized (passkeys.lock()) {
            return uses.containsKey(key(keySha256, digest));
        }
    }

    @Override
    public Outcome record(PasskeyUse use) {
        synchronized (passkeys.lock()) {
            String key = key(use.keySha256(), use.digest());
            if (uses.containsKey(key)) {
                return Outcome.REPLAY;
            }
            InMemoryPasskeyRepository.Move moved = passkeys.moveCounter(use.passkeyId(), use.signCount(), use.at());
            if (moved.outcome() == Outcome.RECORDED) {
                // Claimed with the counter this move replaced, in the same step (under the one lock).
                uses.put(key, new Held(use, moved.replaced()));
            }
            // Otherwise the store transaction rolls back: nothing is claimed.
            return moved.outcome();
        }
    }

    @Override
    public void release(PasskeyUse use) {
        synchronized (passkeys.lock()) {
            String key = key(use.keySha256(), use.digest());
            Held held = uses.get(key);
            // Only this use's claim: never another request's of the same digest.
            if (held != null && held.use().passkeyId() == use.passkeyId() && held.use().at().equals(use.at())
                && held.use().signCount() == use.signCount()) {
                uses.remove(key);
                passkeys.restoreCounter(use.passkeyId(), use.signCount(), held.replaced());
            }
        }
    }

    @Override
    public long signedCount(long passkeyId) {
        synchronized (passkeys.lock()) {
            return uses.values().stream().filter(held -> held.use().passkeyId() == passkeyId).count();
        }
    }
}
