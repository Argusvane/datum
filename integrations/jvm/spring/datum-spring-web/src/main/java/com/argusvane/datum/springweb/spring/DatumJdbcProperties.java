package com.argusvane.datum.springweb.spring;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.sql.init.DatabaseInitializationMode;

/**
 * {@code datum.jdbc.*}: how the JDBC stores of the Datum modules get their tables.
 * The shape is Spring Session's {@code initialize-schema}: an application with no migration tool gets the tables without a
 * script of its own, and one with Flyway or Liquibase says {@code never} and keeps running the scripts it ships.
 */
@ConfigurationProperties(prefix = "datum.jdbc")
public class DatumJdbcProperties {

    /**
     * Whether the Datum modules create their tables when a JDBC store starts: {@code embedded} (the default) only in an embedded
     * in-memory database (H2, HSQL, Derby), {@code always} in whatever database the stores use, {@code never} not at all. The
     * module's own script (META-INF/datum/db/migration/&lt;database&gt;/V*.sql) runs only when that module's first table is
     * missing, so {@code always} is safe to leave on and a table made by Flyway or by hand is never created twice. With Flyway or
     * Liquibase set {@code never} and run the same scripts there: a persistent database's schema is the application's.
     */
    private DatabaseInitializationMode initializeSchema = DatabaseInitializationMode.EMBEDDED;

    public DatabaseInitializationMode getInitializeSchema() {
        return initializeSchema;
    }

    public void setInitializeSchema(DatabaseInitializationMode initializeSchema) {
        this.initializeSchema = initializeSchema;
    }
}
