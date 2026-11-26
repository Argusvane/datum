package com.argusvane.datum.forms.spring;

import javax.sql.DataSource;
import org.junit.jupiter.api.Tag;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;

/**
 * {@link SnapshotStoreContainersContract} on a real Postgresql. Tagged {@code containers}:
 * it runs in the {@code containers} profile and is skipped where Docker does not answer.
 */
@Tag("containers")
@Testcontainers(disabledWithoutDocker = true)
class SnapshotStorePostgresqlContainersTest extends SnapshotStoreContainersContract {

    @Container
    static final PostgreSQLContainer POSTGRESQL = new PostgreSQLContainer("postgres:17-alpine");

    @Override
    protected DataSource database() throws Exception {
        return DatumContainerDatabases.fresh(POSTGRESQL);
    }
}
