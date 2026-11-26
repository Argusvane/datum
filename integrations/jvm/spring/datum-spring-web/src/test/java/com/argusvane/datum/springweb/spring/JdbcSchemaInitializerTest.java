package com.argusvane.datum.springweb.spring;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.core.DatumConfigurationException;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.UUID;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.sql.init.DatabaseInitializationMode;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

/**
 * The tables of a module are made when the mode asks for it and the module's first table is missing, and
 * never otherwise. The script here is a stand-in with the module's probe table (the real scripts are run against the real
 * stores in each binding's tests).
 */
class JdbcSchemaInitializerTest {

    private static DataSource memory() {
        return new DriverManagerDataSource("jdbc:h2:mem:" + UUID.randomUUID() + ";DB_CLOSE_DELAY=-1", "sa", "");
    }

    private static boolean has(DataSource dataSource, String table) throws SQLException {
        try (Connection connection = dataSource.getConnection();
             ResultSet found = connection.getMetaData().getTables(null, null, table.toUpperCase(), new String[] {"TABLE"})) {
            return found.next();
        }
    }

    @Test
    void embeddedMakesTheTablesInAnInMemoryDatabaseOnce() throws SQLException {
        DataSource dataSource = memory();
        JdbcSchemaInitializer initializer = new JdbcSchemaInitializer(DatabaseInitializationMode.EMBEDDED);
        assertThat(initializer.initialize(dataSource, JdbcSchemaInitializer.Schema.FORMS)).isTrue();
        assertThat(has(dataSource, "datum_definition_snapshot")).isTrue();
        // The scripts are not idempotent: a second call finds the table and runs nothing.
        assertThat(initializer.initialize(dataSource, JdbcSchemaInitializer.Schema.FORMS)).isFalse();
    }

    @Test
    void neverMakesNothing() throws SQLException {
        DataSource dataSource = memory();
        assertThat(new JdbcSchemaInitializer(DatabaseInitializationMode.NEVER).initialize(dataSource, JdbcSchemaInitializer.Schema.FORMS)).isFalse();
        assertThat(has(dataSource, "datum_definition_snapshot")).isFalse();
    }

    @Test
    void embeddedLeavesAPersistentDatabaseAloneAndAlwaysMakesTheTablesThere(@TempDir Path directory) throws SQLException {
        DataSource file = new DriverManagerDataSource("jdbc:h2:file:" + directory.resolve("datum") + ";DB_CLOSE_DELAY=-1", "sa", "");
        assertThat(new JdbcSchemaInitializer(DatabaseInitializationMode.EMBEDDED).initialize(file, JdbcSchemaInitializer.Schema.FORMS))
            .as("a file database is not embedded in memory").isFalse();
        assertThat(has(file, "datum_definition_snapshot")).isFalse();
        assertThat(new JdbcSchemaInitializer(DatabaseInitializationMode.ALWAYS).initialize(file, JdbcSchemaInitializer.Schema.FORMS)).isTrue();
        assertThat(has(file, "datum_definition_snapshot")).isTrue();
        assertThat(new JdbcSchemaInitializer(DatabaseInitializationMode.ALWAYS).initialize(file, JdbcSchemaInitializer.Schema.FORMS))
            .as("always never creates a table twice").isFalse();
    }

    @Test
    void aTableTheApplicationMadeItselfIsLeftAloneWhateverTheMode() throws SQLException {
        DataSource dataSource = memory();
        try (Connection connection = dataSource.getConnection()) {
            connection.createStatement().execute("CREATE TABLE datum_definition_snapshot (own INT)");
        }
        assertThat(new JdbcSchemaInitializer(DatabaseInitializationMode.ALWAYS).initialize(dataSource, JdbcSchemaInitializer.Schema.FORMS)).isFalse();
    }

    @Test
    void aDatabaseWithoutAScriptIsRefusedNamingTheSettingAndTheWayOut() {
        // The stand-in scripts exist for H2 only; the SUBMISSIONS script is not among them, as an unsupported database's would not be.
        assertThatThrownBy(() -> new JdbcSchemaInitializer(DatabaseInitializationMode.ALWAYS).initialize(memory(), JdbcSchemaInitializer.Schema.SUBMISSIONS))
            .isInstanceOfSatisfying(DatumConfigurationException.class, refusal -> {
                assertThat(refusal.property()).isEqualTo("datum.jdbc.initialize-schema");
                assertThat(refusal.getMessage()).contains("V200__datum_submissions.sql");
                assertThat(refusal.action()).contains("never");
            });
    }

    @Test
    void theDatabaseProductPicksTheScriptsDirectory() {
        assertThat(JdbcSchemaInitializer.dialect("PostgreSQL")).isEqualTo("postgresql");
        assertThat(JdbcSchemaInitializer.dialect("MySQL")).isEqualTo("mysql");
        assertThat(JdbcSchemaInitializer.dialect("MariaDB")).isEqualTo("mysql");
        assertThat(JdbcSchemaInitializer.dialect("H2")).isEqualTo("h2");
        assertThat(JdbcSchemaInitializer.embedded("jdbc:h2:mem:x")).isTrue();
        assertThat(JdbcSchemaInitializer.embedded("jdbc:h2:file:/x")).isFalse();
        assertThat(JdbcSchemaInitializer.embedded("jdbc:postgresql://host/db")).isFalse();
    }

    @Test
    void aSameNamedTableInAnotherSchemaDoesNotHideAMissingOne() throws SQLException {
        DataSource dataSource = memory();
        try (Connection connection = dataSource.getConnection()) {
            connection.createStatement().execute("CREATE SCHEMA other");
            connection.createStatement().execute("CREATE TABLE other.datum_definition_snapshot (own INT)");
        }
        assertThat(new JdbcSchemaInitializer(DatabaseInitializationMode.ALWAYS).initialize(dataSource, JdbcSchemaInitializer.Schema.FORMS))
            .as("the table in schema OTHER is not this connection's").isTrue();
    }

    @Test
    void aOneConnectionPoolDoesNotStallTheScript() {
        DriverManagerDataSource target = new DriverManagerDataSource("jdbc:h2:mem:" + UUID.randomUUID() + ";DB_CLOSE_DELAY=-1", "sa", "");
        int[] open = {0};
        DataSource single = new org.springframework.jdbc.datasource.AbstractDataSource() {
            @Override
            public Connection getConnection() throws SQLException {
                if (open[0] > 0) {
                    throw new SQLException("pool of one is exhausted");
                }
                open[0]++;
                Connection real = target.getConnection();
                return (Connection) java.lang.reflect.Proxy.newProxyInstance(getClass().getClassLoader(), new Class<?>[] {Connection.class},
                    (proxy, method, args) -> {
                        if (method.getName().equals("close")) {
                            open[0]--;
                        }
                        try {
                            return method.invoke(real, args);
                        } catch (java.lang.reflect.InvocationTargetException e) {
                            throw e.getCause();
                        }
                    });
            }

            @Override
            public Connection getConnection(String user, String password) throws SQLException {
                return getConnection();
            }
        };
        assertThat(new JdbcSchemaInitializer(DatabaseInitializationMode.ALWAYS).initialize(single, JdbcSchemaInitializer.Schema.FORMS)).isTrue();
    }
}
