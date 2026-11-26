package com.argusvane.datum.submissions.spring;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.submissions.idempotency.SubmissionIdempotencyStoreContract;
import com.argusvane.datum.submissions.spi.SubmissionReceipt;
import java.time.Clock;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * The idempotency store and the shipped script on a real PostgreSQL and a real
 * MySQL. Tagged {@code containers}: it runs in the {@code containers} profile and is skipped where Docker does not answer.
 */
abstract class IdempotencyStoreContainersContract {

    /** The clean database of the subclass's container (the container is started once for the class, never passed as an argument). */
    protected abstract DataSource database() throws Exception;

    @Test
    void theLibrarysContractHoldsOnTheRealDatabase() throws Exception {
        DataSource source = database();
        JdbcSubmissionIdempotencyStore store = new JdbcSubmissionIdempotencyStore(source, Clock.systemUTC());
        store.probe();
        SubmissionIdempotencyStoreContract.check(store);
    }

    /** Two nodes racing one document: the loser's duplicate key is "already remembered", the first receipt stays, one row. */
    @Test
    void racingRemembersOfOneDocumentAllSucceedAndTheFirstReceiptStays() throws Exception {
        DataSource source = database();
        JdbcSubmissionIdempotencyStore store = new JdbcSubmissionIdempotencyStore(source, Clock.systemUTC());
        int threads = 8;
        for (int round = 0; round < 10; round++) {
            String digest = String.format("%064x", round);
            String key = "attempt-" + round;
            CyclicBarrier start = new CyclicBarrier(threads);
            ExecutorService pool = Executors.newFixedThreadPool(threads);
            List<Future<?>> runs = new ArrayList<>();
            for (int t = 0; t < threads; t++) {
                SubmissionReceipt receipt = new SubmissionReceipt("receipt-" + t, null, null);
                runs.add(pool.submit(() -> {
                    start.await();
                    store.remember("contact", "1", key, digest, receipt);
                    return null;
                }));
            }
            for (Future<?> run : runs) {
                run.get();
            }
            pool.shutdown();
            assertThat(store.find("contact", "1", key)).isPresent();
        }
        assertThat(new JdbcTemplate(source).queryForObject("SELECT COUNT(*) FROM datum_submission_digest", Integer.class)).isEqualTo(10);
    }
}
