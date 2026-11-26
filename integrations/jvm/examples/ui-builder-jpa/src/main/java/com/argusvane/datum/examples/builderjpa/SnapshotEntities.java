package com.argusvane.datum.examples.builderjpa;

import org.springframework.data.jpa.repository.JpaRepository;

/** Spring Data access to {@link SnapshotEntity}. */
public interface SnapshotEntities extends JpaRepository<SnapshotEntity, SnapshotEntity.Id> {
}
