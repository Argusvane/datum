package com.argusvane.datum.forms.snapshot;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.node.ObjectNode;

/**
 * The in-memory snapshot store keeps the {@link DefinitionSnapshotStoreContract}, is bounded and warns; the shipped SQL
 * scripts carry the table. The SQL store itself is the Spring binding's (datum-forms-spring
 * JdbcDefinitionSnapshotStoreTest: the contract on H2, the 8 x 20 race, no table created).
 */
class DefinitionSnapshotStoreTest {

    @Test
    void inMemoryStoreKeepsSnapshotsAndWarnsAtStartup() {
        List<String> warnings = new ArrayList<>();
        InMemoryDefinitionSnapshotStore store = new InMemoryDefinitionSnapshotStore(10, warnings::add);

        DefinitionSnapshotStoreContract.check(store);

        assertThat(warnings).hasSize(1);
        assertThat(warnings.get(0)).contains("in memory").contains("DefinitionSnapshotStore");
    }

    /** The one-argument constructor writes nothing; the WARN is the start-up check's, and only for this store. */
    @Test
    void theStartupCheckWarnsForTheInMemoryStoreOnly() {
        InMemoryDefinitionSnapshotStore store = new InMemoryDefinitionSnapshotStore(7);

        var notices = InMemoryDefinitionSnapshotStore.startupCheck(store).check();

        assertThat(notices).hasSize(1);
        assertThat(notices.get(0).level()).isEqualTo(com.argusvane.datum.core.DatumStartupCheck.Level.WARN);
        assertThat(notices.get(0).message()).contains("at most 7").contains("DefinitionSnapshotStore");
        DefinitionSnapshotStore mine = new DefinitionSnapshotStore() {
            @Override
            public void record(String key, String sha256, ObjectNode definition) { }

            @Override
            public java.util.Optional<ObjectNode> find(String key, String sha256) {
                return java.util.Optional.empty();
            }
        };
        assertThat(InMemoryDefinitionSnapshotStore.startupCheck(mine).check()).isEmpty();
        assertThat(InMemoryDefinitionSnapshotStore.startupCheck(null).check()).isEmpty();
    }

    @Test
    void inMemoryStoreIsBoundedLeastRecentlyUsedFirst() {
        InMemoryDefinitionSnapshotStore store = new InMemoryDefinitionSnapshotStore(2, message -> { });
        ObjectNode definition = DefinitionSnapshotStoreContract.definition("1");
        store.record("f", "a", definition);
        store.record("f", "b", definition);
        store.find("f", "a");
        store.record("f", "c", definition);

        assertThat(store.size()).isEqualTo(2);
        assertThat(store.find("f", "a")).isPresent();
        assertThat(store.find("f", "b")).as("b was the least recently used").isEmpty();
        assertThat(store.find("f", "c")).isPresent();
    }

    @Test
    void everyDialectShipsTheSameTable() throws IOException {
        for (String dialect : List.of("h2", "postgresql", "mysql")) {
            String sql = new String(getClass().getClassLoader().getResourceAsStream("META-INF/datum/db/migration/" + dialect + "/V100__datum_forms.sql")
                .readAllBytes(), StandardCharsets.UTF_8);
            assertThat(sql).as(dialect).contains("CREATE TABLE datum_definition_snapshot").contains("PRIMARY KEY (form_key, sha256)");
        }
    }
}
