package com.argusvane.datum.springweb.spring;

import com.argusvane.datum.core.DatumConfigurationException;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.Locale;
import java.util.Objects;
import javax.sql.DataSource;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.sql.init.DatabaseInitializationMode;
import org.springframework.core.io.ClassPathResource;
import org.springframework.core.io.Resource;
import org.springframework.core.io.support.EncodedResource;
import org.springframework.jdbc.datasource.init.ScriptUtils;

/**
 * Creates the tables of a Datum module's JDBC stores when the application has no migration tool for them (the shape of
 * Spring Session's {@code initialize-schema}). The script is the module's own
 * {@code META-INF/datum/db/migration/<database>/V*.sql}, the bytes Flyway and Liquibase use, so the two ways of making the
 * tables cannot drift.
 *
 * <p>Called by a store's bean method, so it runs after Flyway, Liquibase and {@code spring.sql.init} (the store beans wait for
 * all of them, {@code @DependsOnDatabaseInitialization}), and only when the module's first table is missing: the scripts are not
 * idempotent, and an application that made the tables itself, or whose migration tool did, is left alone whatever the mode.
 * That is the one difference from Boot's {@code always}.
 */
public final class JdbcSchemaInitializer {

    private static final Logger LOG = LoggerFactory.getLogger("datum.jdbc");

    /** A module's script and the table whose presence means the module's tables exist. */
    public enum Schema {
        FORMS("V100__datum_forms.sql", "datum_definition_snapshot", "forms"),
        SUBMISSIONS("V200__datum_submissions.sql", "datum_submission_digest", "submissions"),
        TIMESTAMP("V300__datum_timestamp.sql", "datum_tsa_log", "timestamp"),
        WEBAUTHN("V400__datum_webauthn.sql", "datum_passkey", "webauthn");

        private final String script;
        private final String probeTable;
        private final String module;

        Schema(String script, String probeTable, String module) {
            this.script = script;
            this.probeTable = probeTable;
            this.module = module;
        }

        /** The script's file name, under the database's directory. */
        public String script() {
            return script;
        }

        /** The table whose presence means the module's tables exist. */
        public String probeTable() {
            return probeTable;
        }
    }

    private final DatabaseInitializationMode mode;

    public JdbcSchemaInitializer(DatabaseInitializationMode mode) {
        this.mode = Objects.requireNonNull(mode, "mode");
    }

    /** The mode this initializer applies. */
    public DatabaseInitializationMode mode() {
        return mode;
    }

    /**
     * Makes the module's tables when the mode asks for it and they are missing.
     *
     * @return whether the script ran
     * @throws DatumConfigurationException when the mode asks for the tables and the database has no script (a database other
     *     than H2, PostgreSQL, MySQL or MariaDB)
     * @throws IllegalStateException when the script fails
     */
    public boolean initialize(DataSource dataSource, Schema schema) {
        Objects.requireNonNull(dataSource, "dataSource");
        Objects.requireNonNull(schema, "schema");
        if (mode == DatabaseInitializationMode.NEVER) {
            return false;
        }
        try (Connection connection = dataSource.getConnection()) {
            DatabaseMetaData meta = connection.getMetaData();
            if (mode == DatabaseInitializationMode.EMBEDDED && !embedded(meta.getURL())) {
                return false;
            }
            if (tableExists(connection, schema.probeTable)) {
                return false;
            }
            String dialect = dialect(meta.getDatabaseProductName());
            Resource script = new ClassPathResource("META-INF/datum/db/migration/" + dialect + "/" + schema.script,
                JdbcSchemaInitializer.class.getClassLoader());
            if (!script.exists()) {
                throw new DatumConfigurationException("datum.jdbc.initialize-schema", "The Datum " + schema.module
                    + " module has no table script for the database " + meta.getDatabaseProductName() + " (looked for "
                    + ((ClassPathResource) script).getPath() + ").",
                    "Run the module's script for your database yourself and set datum.jdbc.initialize-schema=never.");
            }
            // Run on the probe connection: a one-connection pool would block for its timeout if the script asked for a second.
            ScriptUtils.executeSqlScript(connection, new EncodedResource(script, "UTF-8"));
            LOG.info("Datum: created the {} tables ({}) with {} in the {} database; datum.jdbc.initialize-schema=never turns this off.",
                schema.module, schema.probeTable, schema.script, dialect);
            return true;
        } catch (SQLException e) {
            throw new IllegalStateException("Datum could not check or create the " + schema.module + " tables: " + e.getMessage(), e);
        }
    }

    /** An embedded in-memory database, as Boot's embedded mode reads it. */
    static boolean embedded(String url) {
        if (url == null) {
            return false;
        }
        String lower = url.toLowerCase(Locale.ROOT);
        return lower.startsWith("jdbc:h2:mem:") || lower.startsWith("jdbc:hsqldb:mem:") || lower.startsWith("jdbc:derby:memory:");
    }

    private static boolean tableExists(Connection connection, String table) throws SQLException {
        DatabaseMetaData meta = connection.getMetaData();
        // Restricted to the connection's own catalog and schema: a null reads as every database (Connector/J) or every schema on
        // the search path (PostgreSQL), so a same-named table elsewhere would hide a missing one here.
        String catalog = connection.getCatalog();
        String currentSchema;
        try {
            currentSchema = connection.getSchema();
        } catch (SQLException | AbstractMethodError e) {
            currentSchema = null;
        }
        // H2 stores an unquoted name upper case, PostgreSQL lower case: ask for both, as the script made it unquoted.
        for (String name : new String[] {table.toUpperCase(Locale.ROOT), table.toLowerCase(Locale.ROOT)}) {
            try (ResultSet found = meta.getTables(catalog, currentSchema, name, new String[] {"TABLE"})) {
                if (found.next()) {
                    return true;
                }
            }
        }
        return false;
    }

    /** The directory of the database's scripts. */
    static String dialect(String product) {
        String name = product == null ? "" : product.toLowerCase(Locale.ROOT);
        if (name.contains("postgres")) {
            return "postgresql";
        }
        if (name.contains("mysql") || name.contains("mariadb")) {
            return "mysql";
        }
        return name.contains("h2") ? "h2" : name.replaceAll("[^a-z0-9]", "");
    }
}
