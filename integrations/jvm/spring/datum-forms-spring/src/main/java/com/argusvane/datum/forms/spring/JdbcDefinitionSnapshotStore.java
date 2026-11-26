package com.argusvane.datum.forms.spring;

import com.argusvane.datum.core.canonical.CanonicalJson;
import com.argusvane.datum.core.contracts.DatumJson;
import com.argusvane.datum.forms.snapshot.DefinitionSnapshotStore;
import com.argusvane.datum.springweb.spring.DatumStoreJdbc;
import java.time.Clock;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import javax.sql.DataSource;
import org.springframework.dao.DuplicateKeyException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * Snapshots in a table the application owns, {@code datum_definition_snapshot}. The store never creates
 * it: the plain-SQL scripts under {@code META-INF/datum/db/migration/{h2,postgresql,mysql}/V100__datum_forms.sql}
 * (shipped by datum-forms, kept in integrations/shared) are for Flyway or Liquibase (or a hand-run psql), so schema
 * changes stay the application's decision.
 *
 * <p>The definition is kept as the canonical JSON the hash was taken over (the {@code definition} column);
 * {@code version} is the definition's {@code version} member, cut to 64 characters, the column's width (a builder save
 * refuses a longer version: DefinitionShape.MAX_VERSION_LENGTH).
 * Only standard SQL is used, so the same statements run on all three databases.
 *
 * <p>On Spring's JDBC: each call is a transaction of
 * its own ({@link DatumStoreJdbc}'s rule), and a racing insert of the same hash is Spring's
 * {@link DuplicateKeyException}, read as "already there".
 */
public final class JdbcDefinitionSnapshotStore implements DefinitionSnapshotStore {

    /** The table name the migration scripts create. */
    public static final String TABLE = "datum_definition_snapshot";

    private final DatumStoreJdbc jdbc;
    private final Clock clock;

    public JdbcDefinitionSnapshotStore(DataSource dataSource) {
        this(DatumStoreJdbc.of(dataSource), Clock.systemUTC());
    }

    public JdbcDefinitionSnapshotStore(DataSource dataSource, Clock clock) {
        this(DatumStoreJdbc.of(dataSource), clock);
    }

    public JdbcDefinitionSnapshotStore(DatumStoreJdbc jdbc, Clock clock) {
        this.jdbc = Objects.requireNonNull(jdbc, "jdbc");
        this.clock = Objects.requireNonNull(clock, "clock");
    }

    @Override
    public void record(String key, String sha256, ObjectNode definition) {
        long present = jdbc.number("SELECT COUNT(*) FROM " + TABLE + " WHERE form_key = ? AND sha256 = ?", key, sha256);
        if (present > 0) {
            return;
        }
        JsonNode version = definition.path("version");
        String versionText = version.isString() ? version.stringValue() : "";
        if (versionText.length() > 64) {
            versionText = versionText.substring(0, 64);
        }
        try {
            jdbc.update("INSERT INTO " + TABLE + " (form_key, sha256, version, definition, created) VALUES (?, ?, ?, ?, ?)",
                key, sha256, versionText, CanonicalJson.serialize(definition), clock.millis());
        } catch (DuplicateKeyException raced) {
            // Another node recorded the same hash between the check and the insert: the same bytes, so done.
        }
    }

    @Override
    public Optional<ObjectNode> find(String key, String sha256) {
        List<String> rows = jdbc.query("SELECT definition FROM " + TABLE + " WHERE form_key = ? AND sha256 = ?", (found, row) -> found.getString(1),
            key, sha256);
        if (rows.isEmpty() || rows.get(0) == null) {
            return Optional.empty();
        }
        JsonNode node = DatumJson.mapper().readTree(rows.get(0));
        return node.isObject() ? Optional.of((ObjectNode) node) : Optional.empty();
    }
}
