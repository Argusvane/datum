package com.argusvane.datum.webauthn.spring;

import com.argusvane.datum.springweb.spring.JdbcSchemaInitializer;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.List;
import javax.sql.DataSource;
import org.springframework.boot.sql.init.DatabaseInitializationMode;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.testcontainers.containers.JdbcDatabaseContainer;

/**
 * A clean database in a Testcontainers PostgreSQL or MySQL, with the module's own shipped script run through the same
 * {@link JdbcSchemaInitializer} the stores use: the script is applied as
 * Flyway would apply it, by the production code path, on the database the integrators run.
 */
final class DatumContainerDatabases {

    /** The Datum tables of this module, dropped before each test so every test starts from the script. */
    private static final List<String> TABLES = List.of("datum_passkey_challenge", "datum_passkey_use", "datum_passkey");

    private DatumContainerDatabases() {
    }

    /** A data source over the container with the module's tables dropped and not made (for a test that applies the script itself). */
    static DataSource clean(JdbcDatabaseContainer<?> container) throws SQLException {
        DataSource source = new DriverManagerDataSource(container.getJdbcUrl(), container.getUsername(), container.getPassword());
        try (Connection connection = source.getConnection(); Statement statement = connection.createStatement()) {
            for (String table : TABLES) {
                statement.execute("DROP TABLE IF EXISTS " + table);
            }
        }
        return source;
    }

    /** A data source over the container with the module's tables made fresh by the initializer. */
    static DataSource fresh(JdbcDatabaseContainer<?> container) throws SQLException {
        DataSource source = clean(container);
        boolean ran = new JdbcSchemaInitializer(DatabaseInitializationMode.ALWAYS).initialize(source, JdbcSchemaInitializer.Schema.WEBAUTHN);
        if (!ran) {
            throw new IllegalStateException("The module's script did not run on " + container.getJdbcUrl());
        }
        return source;
    }
}
