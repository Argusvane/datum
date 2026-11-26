package com.argusvane.datum.webauthn.spring;

import javax.sql.DataSource;
import org.junit.jupiter.api.Tag;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.mysql.MySQLContainer;

/**
 * {@link JdbcStoresContract} on a real MySQL: the passkey stores' row lock, the
 * unique keys and the duplicate-key translation on the database integrators run, not H2's MySQL mode.
 * Tagged {@code containers}: it runs in the {@code containers} profile and is skipped where Docker does not answer.
 */
@Tag("containers")
@Testcontainers(disabledWithoutDocker = true)
class JdbcStoresMysqlContainersTest extends JdbcStoresContract {

    @Container
    static final MySQLContainer MYSQL = new MySQLContainer("mysql:8.4");

    @Override
    protected String dialect() {
        return "mysql";
    }

    @Override
    protected String mode() {
        return "";
    }

    @Override
    protected DataSource newDatabase() throws Exception {
        return DatumContainerDatabases.clean(MYSQL);
    }
}
