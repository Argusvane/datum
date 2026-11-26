package com.argusvane.datum.webauthn;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.TreeMap;
import java.util.function.LongPredicate;

/**
 * {@link PasskeyRepository} in this process's memory: single-instance use and tests. Every method holds the
 * repository's lock, which {@link InMemoryPasskeyUseStore} shares so a use's claim and counter move are one step.
 */
public final class InMemoryPasskeyRepository implements PasskeyRepository {

    private final Object lock = new Object();
    private final Map<Long, PasskeyRecord> passkeys = new TreeMap<>();
    private long nextId = 1;
    /** Whether a stored use names a passkey; the use store over this repository sets it (the purge keeps what signed). */
    private LongPredicate hasUse = id -> false;

    Object lock() {
        return lock;
    }

    /** The use store's view of which passkeys signed something stored. */
    void usesBy(LongPredicate hasUse) {
        synchronized (lock) {
            this.hasUse = hasUse;
        }
    }

    @Override
    public Optional<PasskeyRecord> find(String credentialId) {
        if (credentialId == null || credentialId.isEmpty() || credentialId.length() > 1400) {
            return Optional.empty();
        }
        synchronized (lock) {
            return passkeys.values().stream().filter(passkey -> passkey.credentialId().equals(credentialId)).findFirst();
        }
    }

    @Override
    public Optional<PasskeyRecord> findById(long id) {
        synchronized (lock) {
            return Optional.ofNullable(passkeys.get(id));
        }
    }

    @Override
    public boolean keyRegistered(String publicKeyHash) {
        synchronized (lock) {
            return passkeys.values().stream().anyMatch(passkey -> passkey.publicKeyHash().equals(publicKeyHash));
        }
    }

    @Override
    public Optional<PasskeyRecord> firstOf(String owner, String formId) {
        synchronized (lock) {
            return passkeys.values().stream()
                .filter(passkey -> passkey.owner().equals(owner) && passkey.formId().equals(formId == null ? "" : formId))
                .findFirst();
        }
    }

    @Override
    public List<PasskeyRecord> ownActive(String owner, String formId) {
        synchronized (lock) {
            List<PasskeyRecord> found = new ArrayList<>();
            for (PasskeyRecord passkey : passkeys.values()) {
                if (!passkey.owner().equals(owner) || passkey.isRevoked()) {
                    continue;
                }
                if (formId != null && !passkey.formId().isEmpty() && !passkey.formId().equals(formId)) {
                    continue;
                }
                found.add(passkey);
            }
            return found;
        }
    }

    @Override
    public List<PasskeyRecord> ofOwner(String owner) {
        synchronized (lock) {
            return passkeys.values().stream().filter(passkey -> passkey.owner().equals(owner) && !passkey.isRemoved()).toList();
        }
    }

    @Override
    public PasskeyRecord create(PasskeyRecord passkey) {
        synchronized (lock) {
            if (passkeys.values().stream().anyMatch(existing -> existing.credentialId().equals(passkey.credentialId()))) {
                throw new DuplicatePasskeyException("A passkey with this credential id is stored already.");
            }
            // The shared SQL's UNIQUE(public_key_sha256): one key, one passkey, revoked and removed ones included. The
            // ceremony's keyRegistered() look-up before this is check-then-act; this is the step that holds.
            String key = passkey.publicKeyHash();
            if (passkeys.values().stream().anyMatch(existing -> existing.publicKeyHash().equals(key))) {
                throw new DuplicatePasskeyException("A passkey with this public key is stored already.");
            }
            PasskeyRecord stored = passkey.toBuilder().id(nextId++).build();
            passkeys.put(stored.id(), stored);
            return stored;
        }
    }

    @Override
    public boolean revoke(long id, String by, Instant at) {
        synchronized (lock) {
            PasskeyRecord passkey = passkeys.get(id);
            if (passkey == null || passkey.isRevoked()) {
                return false;
            }
            passkeys.put(id, passkey.toBuilder().revoked(at).revokedBy(by == null ? "" : by).build());
            return true;
        }
    }

    @Override
    public boolean markRemoved(long id, Instant at) {
        synchronized (lock) {
            PasskeyRecord passkey = passkeys.get(id);
            if (passkey == null || passkey.isRemoved()) {
                return false;
            }
            passkeys.put(id, passkey.toBuilder().removed(at).label("").build());
            return true;
        }
    }

    @Override
    public boolean delete(long id) {
        synchronized (lock) {
            return passkeys.remove(id) != null;
        }
    }

    @Override
    public boolean touch(long id, long signCount, Instant at) {
        synchronized (lock) {
            PasskeyRecord passkey = passkeys.get(id);
            if (passkey == null) {
                return false;
            }
            long counter = Math.max(passkey.signCount(), signCount);
            passkeys.put(id, passkey.toBuilder().lastUsed(at).signCount(counter).build());
            return true;
        }
    }

    @Override
    public int purgeAnonymous(Instant before, int limit) {
        synchronized (lock) {
            List<Long> doomed = new ArrayList<>();
            for (PasskeyRecord passkey : passkeys.values()) {
                if (doomed.size() >= Math.max(1, limit)) {
                    break;
                }
                if (passkey.owner().isEmpty() && !"invitation".equals(passkey.origin()) && passkey.created().isBefore(before)
                    && !hasUse.test(passkey.id())) {
                    doomed.add(passkey.id());
                }
            }
            doomed.forEach(passkeys::remove);
            return doomed.size();
        }
    }

    /**
     * The conditional counter move of a use (the JDBC store's {@code UPDATE datum_passkey ... WHERE id AND NOT revoked AND
     * sign_count < count}, or {@code = 0} for an authenticator that keeps none). Called under {@link #lock()}.
     */
    Move moveCounter(long id, long count, Instant at) {
        PasskeyRecord passkey = passkeys.get(id);
        if (passkey == null || passkey.isRevoked()) {
            return new Move(PasskeyUseStore.Outcome.REVOKED, 0);
        }
        boolean moves = count > 0 ? passkey.signCount() < count : passkey.signCount() == count;
        if (!moves) {
            return new Move(PasskeyUseStore.Outcome.COUNTER, 0);
        }
        passkeys.put(id, passkey.toBuilder().signCount(count).lastUsed(at).build());
        return new Move(PasskeyUseStore.Outcome.RECORDED, passkey.signCount());
    }

    /** What a counter move did, and the counter it replaced (meaningful when recorded). */
    record Move(PasskeyUseStore.Outcome outcome, long replaced) {
    }

    /** Puts a counter back when it still is {@code from}. Called under {@link #lock()}. */
    void restoreCounter(long id, long from, long to) {
        PasskeyRecord passkey = passkeys.get(id);
        if (passkey != null && passkey.signCount() == from) {
            passkeys.put(id, passkey.toBuilder().signCount(to).build());
        }
    }
}
