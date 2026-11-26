package com.argusvane.datum.submissions.idempotency;

import com.argusvane.datum.submissions.spi.SubmissionIdempotencyStore;
import com.argusvane.datum.submissions.spi.SubmissionIdempotencyStore.Remembered;
import com.argusvane.datum.submissions.spi.SubmissionReceipt;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;

/**
 * The default idempotency store: the receipts of the last {@code maxEntries} accepted submit attempts, with the digest
 * each was accepted with, in memory. When it is full the oldest entry is forgotten, so memory stays bounded under a
 * flood of distinct attempts at the price of accepting a very old retry a second time. State is per process and lost on restart, which the startup
 * WARN and the health detail {@code idempotency: memory} say; the JDBC store (or an application bean) is the
 * answer behind several instances.
 */
public final class InMemorySubmissionIdempotencyStore implements SubmissionIdempotencyStore {

    /** The default bound on remembered attempts. */
    public static final int DEFAULT_MAX_ENTRIES = 10_000;

    private record Key(String formKey, String version, String submissionKey) {
    }

    private final int maxEntries;
    private final Map<Key, Remembered> receipts;

    public InMemorySubmissionIdempotencyStore(int maxEntries) {
        this.maxEntries = Math.max(16, maxEntries);
        // Insertion order: the oldest acceptance goes first. Access does not refresh it, so a hot duplicate
        // cannot keep an entry alive forever.
        this.receipts = new LinkedHashMap<>();
    }

    @Override
    public synchronized Optional<Remembered> find(String formKey, String version, String submissionKey) {
        return Optional.ofNullable(receipts.get(new Key(formKey, version, submissionKey)));
    }

    @Override
    public synchronized void remember(String formKey, String version, String submissionKey, String digest, SubmissionReceipt receipt) {
        Remembered remembered = new Remembered(digest, receipt);
        Key key = new Key(formKey, version, submissionKey);
        if (receipts.containsKey(key)) {
            return;
        }
        if (receipts.size() >= maxEntries) {
            var oldest = receipts.keySet().iterator();
            oldest.next();
            oldest.remove();
        }
        receipts.put(key, remembered);
    }

    /** How many attempts are remembered (tests, health). */
    public synchronized int size() {
        return receipts.size();
    }

    /** Forgets every attempt (tests). */
    public synchronized void clear() {
        receipts.clear();
    }

    /** The bound on remembered attempts. */
    public int maxEntries() {
        return maxEntries;
    }
}
