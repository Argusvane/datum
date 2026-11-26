package com.argusvane.datum.forms.spring;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.forms.snapshot.DefinitionSnapshotStoreContract;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import tools.jackson.databind.node.ObjectNode;

/**
 * The snapshot store and the shipped script on a real PostgreSQL and a real MySQL (one concrete subclass per database, each with a static container started once for the class, the shape of the WebAuthn stores' tests: a container passed as a parameterized argument is auto-closed by JUnit after the first invocation),
 * not H2's modes of them. Tagged {@code containers}: it runs in the {@code containers} profile (a CI Linux runner, or
 * {@code -Pcontainers} where Docker answers) and is skipped where it does not.
 */
abstract class SnapshotStoreContainersContract {

    /** The clean database of the subclass's container (the container is started once for the class, never passed as an argument). */
    protected abstract DataSource database() throws Exception;

    @Test
    void theLibrarysContractHoldsOnTheRealDatabase() throws Exception {
        DataSource source = database();
        DefinitionSnapshotStoreContract.check(new JdbcDefinitionSnapshotStore(source));
        assertThat(new JdbcTemplate(source).queryForObject("SELECT COUNT(*) FROM datum_definition_snapshot", Integer.class)).isEqualTo(2);
    }

    /** Instances racing to record one version all succeed: the loser's duplicate key is translated to "already there". */
    @Test
    void racingRecordsOfOneVersionAllSucceedWithOneRow() throws Exception {
        DataSource source = database();
        JdbcDefinitionSnapshotStore store = new JdbcDefinitionSnapshotStore(source);
        ObjectNode definition = DefinitionSnapshotStoreContract.definition("race");
        int threads = 8;
        for (int round = 0; round < 10; round++) {
            String sha = ("sha-" + round).repeat(1);
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
        assertThat(new JdbcTemplate(source).queryForObject("SELECT COUNT(*) FROM datum_definition_snapshot", Integer.class)).isEqualTo(10);
    }
}
