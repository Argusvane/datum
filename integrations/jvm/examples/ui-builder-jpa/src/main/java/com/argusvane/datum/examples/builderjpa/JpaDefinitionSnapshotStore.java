package com.argusvane.datum.examples.builderjpa;

import com.argusvane.datum.core.contracts.DatumJson;
import com.argusvane.datum.forms.snapshot.DefinitionSnapshotStore;
import java.time.Clock;
import java.util.Optional;
import org.springframework.dao.DataIntegrityViolationException;
import tools.jackson.databind.node.ObjectNode;

/**
 * The snapshot store on the same database as the forms. A bean of this type replaces the forms module's own
 * (JDBC, or in memory with a warning), so the snapshots live beside the forms and follow their transactions.
 */
public class JpaDefinitionSnapshotStore implements DefinitionSnapshotStore {

    private final SnapshotEntities snapshots;
    private final Clock clock;

    public JpaDefinitionSnapshotStore(SnapshotEntities snapshots, Clock clock) {
        this.snapshots = snapshots;
        this.clock = clock;
    }

    @Override
    public void record(String key, String sha256, ObjectNode definition) {
        SnapshotEntity.Id id = new SnapshotEntity.Id(key, sha256);
        if (snapshots.existsById(id)) {
            return;
        }
        try {
            snapshots.save(new SnapshotEntity(id, DatumJson.mapper().writeValueAsString(definition), clock.instant()));
        } catch (DataIntegrityViolationException raced) {
            // Another request recorded the same version first: recording is idempotent, so that is the same result.
        }
    }

    @Override
    public Optional<ObjectNode> find(String key, String sha256) {
        return snapshots.findById(new SnapshotEntity.Id(key, sha256))
            .map(snapshot -> (ObjectNode) DatumJson.mapper().readTree(snapshot.getJson()));
    }
}
