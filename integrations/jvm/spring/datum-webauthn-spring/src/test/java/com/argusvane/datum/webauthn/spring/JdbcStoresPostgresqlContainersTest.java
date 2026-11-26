package com.argusvane.datum.webauthn.spring;

import javax.sql.DataSource;
import org.junit.jupiter.api.Tag;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;

/**
 * {@link JdbcStoresContract} on a real PostgreSQL: the passkey stores' SELECT ...
 * FOR UPDATE claim, the unique keys and the duplicate-key translation on the database integrators run, not H2's PostgreSQL mode.
 * Tagged {@code containers}: it runs in the {@code containers} profile and is skipped where Docker does not answer.
 */
@Tag("containers")
@Testcontainers(disabledWithoutDocker = true)
class JdbcStoresPostgresqlContainersTest extends JdbcStoresContract {

    @Container
    static final PostgreSQLContainer POSTGRESQL = new PostgreSQLContainer("postgres:17-alpine");

    @Override
    protected String dialect() {
        return "postgresql";
    }

    @Override
    protected String mode() {
        return "";
    }

    @Override
    protected DataSource newDatabase() throws Exception {
        return DatumContainerDatabases.clean(POSTGRESQL);
    }
}
