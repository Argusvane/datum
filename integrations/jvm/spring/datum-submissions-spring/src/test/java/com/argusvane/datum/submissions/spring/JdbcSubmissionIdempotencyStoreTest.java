package com.argusvane.datum.submissions.spring;

import static com.argusvane.datum.submissions.idempotency.SubmissionIdempotencyStoreContract.D1;
import static com.argusvane.datum.submissions.idempotency.SubmissionIdempotencyStoreContract.D2;
import static com.argusvane.datum.submissions.idempotency.SubmissionIdempotencyStoreContract.K1;
import static com.argusvane.datum.submissions.idempotency.SubmissionIdempotencyStoreContract.receipt;
import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.submissions.idempotency.SubmissionIdempotencyStoreContract;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

/**
 * The SQL idempotency store on Spring's JDBC: the library's contract on every shipped script, a later remember keeping the first row, and two
 * nodes racing one document (8 threads x 20 rounds per script) with no failure and one row.
 */
class JdbcSubmissionIdempotencyStoreTest {

    private JdbcTemplate database(String mode, String script) throws Exception {
        DriverManagerDataSource source = new DriverManagerDataSource(
            "jdbc:h2:mem:" + UUID.randomUUID() + ";MODE=" + mode + ";DB_CLOSE_DELAY=-1", "sa", "");
        JdbcTemplate jdbc = new JdbcTemplate(source);
        String sql = new String(new ClassPathResource("META-INF/datum/db/migration/" + script + "/V200__datum_submissions.sql")
            .getContentAsByteArray(), StandardCharsets.UTF_8);
        for (String statement : sql.replaceAll("(?m)^--.*$", "").split(";")) {
            if (!statement.isBlank()) {
                jdbc.execute(statement);
            }
        }
        return jdbc;
    }

    @Test
    void keepsTheContractOnTheH2Script() throws Exception {
        SubmissionIdempotencyStoreContract.check(new JdbcSubmissionIdempotencyStore(database("REGULAR", "h2").getDataSource(), Clock.systemUTC()));
    }

    @Test
    void keepsTheContractOnThePostgresqlScript() throws Exception {
        SubmissionIdempotencyStoreContract.check(new JdbcSubmissionIdempotencyStore(database("PostgreSQL", "postgresql").getDataSource(), Clock.systemUTC()));
    }

    @Test
    void keepsTheContractOnTheMysqlScript() throws Exception {
        SubmissionIdempotencyStoreContract.check(new JdbcSubmissionIdempotencyStore(database("MySQL", "mysql").getDataSource(), Clock.systemUTC()));
    }

    /**
     * The transaction rule (DatumStoreJdbc): a receipt remembered while the caller's transaction is open
     * (a handler that stores the submission in a transaction of its own and then fails) is committed on its own, so a
     * redelivery is still answered with it ({@code handled: true}); the application's own row is rolled back.
     */
    @Test
    void aReceiptIsRememberedWhateverTheCallersTransactionDoes() throws Exception {
        JdbcTemplate jdbc = database("REGULAR", "h2");
        javax.sql.DataSource source = jdbc.getDataSource();
        org.springframework.transaction.PlatformTransactionManager application = new org.springframework.jdbc.support.JdbcTransactionManager(source);
        jdbc.execute("CREATE TABLE app_submission (id VARCHAR(64) PRIMARY KEY)");
        JdbcSubmissionIdempotencyStore store = new JdbcSubmissionIdempotencyStore(
            com.argusvane.datum.springweb.spring.DatumStoreJdbc.of(source, application), Clock.systemUTC());

        new org.springframework.transaction.support.TransactionTemplate(application).executeWithoutResult(status -> {
            jdbc.update("INSERT INTO app_submission (id) VALUES ('s1')");
            store.remember("contact", "1", K1, D1, receipt("first"));
            status.setRollbackOnly();
        });

        assertThat(store.find("contact", "1", K1).orElseThrow().receipt().id()).isEqualTo("first");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM app_submission", Integer.class)).as("the application's row is rolled back").isZero();
    }

    /** A second remember of one document, after the first committed, is Spring's DuplicateKeyException and ignored. */
    @ParameterizedTest(name = "{1} script, H2 mode {0}")
    @CsvSource({"REGULAR, h2", "PostgreSQL, postgresql", "MySQL, mysql"})
    void aLaterRememberKeepsTheFirstRow(String mode, String script) throws Exception {
        JdbcTemplate jdbc = database(mode, script);
        JdbcSubmissionIdempotencyStore one = new JdbcSubmissionIdempotencyStore(jdbc.getDataSource());
        JdbcSubmissionIdempotencyStore other = new JdbcSubmissionIdempotencyStore(jdbc.getDataSource());
        one.remember("contact", "1", K1, D1, receipt("one"));
        other.remember("contact", "1", K1, D2, receipt("other"));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM datum_submission_digest", Integer.class)).isEqualTo(1);
        assertThat(other.find("contact", "1", K1).orElseThrow().receipt().id()).isEqualTo("one");
        assertThat(other.find("contact", "1", K1).orElseThrow().digest()).isEqualTo(D1);
    }

    /**
     * Two nodes delivering one document at once (on every shipped script): eight threads
     * remember one submission key together, every round. None of them sees a failure (a DataAccessException here would answer
     * the delivery 500 instead of its receipt), one row is kept, and every instance then answers the same receipt, the
     * one whose insert committed.
     */
    @ParameterizedTest(name = "{1} script, H2 mode {0}")
    @CsvSource({"REGULAR, h2", "PostgreSQL, postgresql", "MySQL, mysql"})
    void racingRemembersOfOneDocumentKeepOneRowAndNoneFails(String mode, String script) throws Exception {
        JdbcTemplate jdbc = database(mode, script);
        int threads = 8;
        int rounds = 20;
        ExecutorService pool = Executors.newFixedThreadPool(threads);
        try {
            for (int round = 0; round < rounds; round++) {
                String digest = String.format("%064d", round);
                String key = "attempt-" + round;
                CyclicBarrier start = new CyclicBarrier(threads);
                List<Future<?>> runs = new ArrayList<>();
                Set<String> racers = new HashSet<>();
                for (int t = 0; t < threads; t++) {
                    String id = "r" + round + "-" + t;
                    racers.add(id);
                    JdbcSubmissionIdempotencyStore node = new JdbcSubmissionIdempotencyStore(jdbc.getDataSource());
                    runs.add(pool.submit(() -> {
                        start.await();
                        node.remember("contact", "1", key, digest, receipt(id));
                        return null;
                    }));
                }
                for (Future<?> run : runs) {
                    run.get();
                }
                String kept = new JdbcSubmissionIdempotencyStore(jdbc.getDataSource()).find("contact", "1", key).orElseThrow().receipt().id();
                assertThat(racers).contains(kept);
                assertThat(jdbc.queryForObject("SELECT receipt_id FROM datum_submission_digest WHERE submission_key = ?", String.class, key))
                    .isEqualTo(kept);
                for (int t = 0; t < threads; t++) {
                    assertThat(new JdbcSubmissionIdempotencyStore(jdbc.getDataSource()).find("contact", "1", key).orElseThrow().receipt().id())
                        .isEqualTo(kept);
                }
            }
        } finally {
            pool.shutdownNow();
        }
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM datum_submission_digest", Integer.class)).isEqualTo(rounds);
    }
}
