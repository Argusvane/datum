package com.argusvane.datum.forms.spring;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.core.canonical.CanonicalJson;
import com.argusvane.datum.forms.snapshot.DefinitionSnapshotStoreContract;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import tools.jackson.databind.node.ObjectNode;

/**
 * The SQL snapshot store on Spring's JDBC: the library's contract over the shipped H2 script, the stored canonical text and time, racing records of one
 * version all succeeding with one row, and no table created by the store.
 */
class JdbcDefinitionSnapshotStoreTest {

    @Test
    void jdbcStoreOnH2WithTheMigrationApplied() throws IOException {
        JdbcTemplate jdbc = h2();
        applyMigration(jdbc, "h2");
        JdbcDefinitionSnapshotStore store = new JdbcDefinitionSnapshotStore(jdbc.getDataSource(),
            Clock.fixed(Instant.parse("2026-10-15T12:00:00Z"), ZoneOffset.UTC));

        DefinitionSnapshotStoreContract.check(store);

        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM datum_definition_snapshot", Integer.class)).isEqualTo(2);
        assertThat(jdbc.queryForObject("SELECT created FROM datum_definition_snapshot WHERE version = '1'", Long.class))
            .isEqualTo(Instant.parse("2026-10-15T12:00:00Z").toEpochMilli());
        // The stored text is the canonical JSON the hash was taken over.
        String sha = CanonicalJson.digest(DefinitionSnapshotStoreContract.definition("1"));
        assertThat(jdbc.queryForObject("SELECT definition FROM datum_definition_snapshot WHERE sha256 = ?", String.class, sha))
            .isEqualTo(CanonicalJson.serialize(DefinitionSnapshotStoreContract.definition("1")));
    }

    /** Instances racing to record one version all succeed: the loser's duplicate key (Spring's DuplicateKeyException) is "already there". */
    @Test
    void racingRecordsOfOneVersionAllSucceed() throws Exception {
        JdbcTemplate jdbc = h2();
        applyMigration(jdbc, "h2");
        JdbcDefinitionSnapshotStore store = new JdbcDefinitionSnapshotStore(jdbc.getDataSource());
        ObjectNode definition = DefinitionSnapshotStoreContract.definition("race");
        int threads = 8;
        for (int round = 0; round < 20; round++) {
            String sha = "sha-" + round;
            CyclicBarrier start = new CyclicBarrier(threads);
            ExecutorService pool = Executors.newFixedThreadPool(threads);
            List<Future<?>> runs = new ArrayList<>();
            for (int t = 0; t < threads; t++) {
                runs.add(pool.submit(() -> {
                    start.await();
                    store.record("f", sha, definition);
                    return null;
                }));
            }
            for (Future<?> run : runs) {
                run.get();
            }
            pool.shutdown();
            assertThat(store.find("f", sha)).isPresent();
        }
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM datum_definition_snapshot", Integer.class)).isEqualTo(20);
    }

    @Test
    void theStoreNeverCreatesItsTable() {
        JdbcTemplate jdbc = h2();
        JdbcDefinitionSnapshotStore store = new JdbcDefinitionSnapshotStore(jdbc.getDataSource());

        assertThatThrownBy(() -> store.find("f", "a")).isInstanceOf(DataAccessException.class);
    }

    private static JdbcTemplate h2() {
        String url = "jdbc:h2:mem:" + UUID.randomUUID() + ";DB_CLOSE_DELAY=-1";
        return new JdbcTemplate(new DriverManagerDataSource(url, "sa", ""));
    }

    /** Applies the shipped script (datum-forms' jar) the way Flyway would: statement by statement. */
    static void applyMigration(JdbcTemplate jdbc, String dialect) throws IOException {
        String script = new String(JdbcDefinitionSnapshotStoreTest.class.getClassLoader()
            .getResourceAsStream("META-INF/datum/db/migration/" + dialect + "/V100__datum_forms.sql").readAllBytes(), StandardCharsets.UTF_8);
        for (String statement : script.split(";")) {
            String sql = statement.lines().filter(line -> !line.strip().startsWith("--")).reduce("", (a, b) -> a + "\n" + b).strip();
            if (!sql.isEmpty()) {
                jdbc.execute(sql);
            }
        }
    }
}
