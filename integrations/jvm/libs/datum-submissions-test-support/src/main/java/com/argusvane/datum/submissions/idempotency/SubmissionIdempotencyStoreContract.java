package com.argusvane.datum.submissions.idempotency;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.submissions.spi.SubmissionIdempotencyStore;
import com.argusvane.datum.submissions.spi.SubmissionReceipt;
import tools.jackson.databind.node.JsonNodeFactory;

/**
 * What every {@link SubmissionIdempotencyStore} keeps: the first receipt wins, the key is (form, version, submission
 * key), the digest the attempt was accepted with comes back beside its receipt, a bare receipt round-trips, a long
 * version is exact, keys are compared exactly (case included). The library's in-memory store and the Spring binding's
 * SQL store (through datum-submissions-test-support) are both held to it.
 */
public final class SubmissionIdempotencyStoreContract {

    public static final String D1 = "a".repeat(64);
    public static final String D2 = "b".repeat(64);
    public static final String K1 = "6f1c1a52-0d6b-4f39-9a3e-1f0e1f6a0001";
    public static final String K2 = "6f1c1a52-0d6b-4f39-9a3e-1f0e1f6a0002";

    private SubmissionIdempotencyStoreContract() {
    }

    public static SubmissionReceipt receipt(String id) {
        return new SubmissionReceipt(id, "REF-" + id, JsonNodeFactory.instance.objectNode().put("title", "Thanks " + id));
    }

    public static void check(SubmissionIdempotencyStore store) {
        assertThat(store.find("contact", "1", K1)).isEmpty();
        store.remember("contact", "1", K1, D1, receipt("first"));
        assertThat(store.find("contact", "1", K1)).hasValueSatisfying(found -> {
            assertThat(found.digest()).isEqualTo(D1);
            assertThat(found.receipt().id()).isEqualTo("first");
            assertThat(found.receipt().reference()).isEqualTo("REF-first");
            assertThat(found.receipt().receipt().path("title").stringValue()).isEqualTo("Thanks first");
        });
        // The first receipt, and its digest, win.
        store.remember("contact", "1", K1, D2, receipt("second"));
        assertThat(store.find("contact", "1", K1).orElseThrow().receipt().id()).isEqualTo("first");
        assertThat(store.find("contact", "1", K1).orElseThrow().digest()).isEqualTo(D1);
        // Another key, version or form is another attempt; a key is compared exactly.
        assertThat(store.find("contact", "1", K2)).isEmpty();
        assertThat(store.find("contact", "1", K1.toUpperCase(java.util.Locale.ROOT))).isEmpty();
        assertThat(store.find("contact", "2", K1)).isEmpty();
        assertThat(store.find("trip", "1", K1)).isEmpty();
        // Two attempts with the same document are two entries.
        store.remember("contact", "1", K2, D1, receipt("other"));
        assertThat(store.find("contact", "1", K2).orElseThrow().receipt().id()).isEqualTo("other");
        // A receipt without a notice or a reference round-trips as such.
        store.remember("trip", "", K2, D2, new SubmissionReceipt("bare", null, null));
        SubmissionReceipt bare = store.find("trip", "", K2).orElseThrow().receipt();
        assertThat(bare.id()).isEqualTo("bare");
        assertThat(bare.reference()).isNull();
        assertThat(bare.receipt() == null || bare.receipt().isNull()).isTrue();
        // A very long version is exact, not cut; so is the longest key.
        String longVersion = "v".repeat(300);
        store.remember("contact", longVersion, K1, D1, receipt("long"));
        assertThat(store.find("contact", longVersion, K1).orElseThrow().receipt().id()).isEqualTo("long");
        assertThat(store.find("contact", "v".repeat(299) + "w", K1)).isEmpty();
        String longest = "k".repeat(128);
        store.remember("contact", "1", longest, D2, receipt("longest"));
        assertThat(store.find("contact", "1", longest).orElseThrow().digest()).isEqualTo(D2);
    }
}
