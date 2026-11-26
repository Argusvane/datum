package com.argusvane.datum.submissions.idempotency;

import static com.argusvane.datum.submissions.idempotency.SubmissionIdempotencyStoreContract.receipt;
import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

/**
 * The in-memory store over the {@link SubmissionIdempotencyStoreContract}, bounded. The SQL store is the Spring
 * binding's (datum-submissions-spring JdbcSubmissionIdempotencyStoreTest: the contract on the three
 * shipped scripts and the 8 x 20 race).
 */
class SubmissionIdempotencyStoreTest {

    @Test
    void keepsTheContract() {
        SubmissionIdempotencyStoreContract.check(new InMemorySubmissionIdempotencyStore(100));
    }

    @Test
    void isBoundedAndForgetsTheOldestFirst() {
        InMemorySubmissionIdempotencyStore store = new InMemorySubmissionIdempotencyStore(16);
        for (int i = 0; i < 40; i++) {
            store.remember("f", "1", "k" + i, String.format("%064d", i), receipt("r" + i));
        }
        assertThat(store.size()).isEqualTo(16);
        assertThat(store.find("f", "1", "k0")).isEmpty();
        assertThat(store.find("f", "1", "k39")).isPresent();
        assertThat(store.find("f", "1", "k24")).isPresent();
        assertThat(store.find("f", "1", "k23")).isEmpty();
    }
}
