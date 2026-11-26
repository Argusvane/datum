package com.argusvane.datum.timestamp.spring;

import com.argusvane.datum.springweb.spring.DatumStoreJdbc;
import com.argusvane.datum.timestamp.TsaClient;
import com.argusvane.datum.timestamp.TsaClientKeys;
import com.argusvane.datum.timestamp.TsaClientStore;
import java.time.Clock;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import javax.sql.DataSource;

/**
 * The timestamp clients in the shared SQL's {@code datum_tsa_client} table: a key's
 * SHA-256 is stored with its first characters as a hint, never the key. A revoked client keeps its row, with the
 * time it was revoked, and its key no longer works. Optional: turn on with {@code datum.tsa.client-store=jdbc}.
 *
 * <p>On Spring's JDBC ({@link DatumStoreJdbc}).
 */
public final class JdbcTsaClientStore implements TsaClientStore {

    /** The table the migration scripts create. */
    public static final String TABLE = "datum_tsa_client";

    /** A client just added with the key to hand over: shown once, never kept. */
    public record Issued(TsaClient client, String key) {
    }

    private final DatumStoreJdbc jdbc;
    private final Clock clock;

    public JdbcTsaClientStore(DataSource dataSource) {
        this(DatumStoreJdbc.of(dataSource), Clock.systemUTC());
    }

    public JdbcTsaClientStore(DataSource dataSource, Clock clock) {
        this(DatumStoreJdbc.of(dataSource), clock);
    }

    public JdbcTsaClientStore(DatumStoreJdbc jdbc, Clock clock) {
        this.jdbc = Objects.requireNonNull(jdbc, "jdbc");
        this.clock = Objects.requireNonNull(clock, "clock");
    }

    /** Adds a client with a new key; the key is in the result and nowhere else. */
    public Issued add(String label) {
        String key = TsaClientKeys.generate();
        long now = clock.millis();
        Object id = jdbc.insert("INSERT INTO " + TABLE + " (label, key_hash, key_hint, created) VALUES (?, ?, ?, ?)",
            label, TsaClientKeys.hash(key), TsaClientKeys.hint(key), now);
        if (!(id instanceof Number number)) {
            throw new IllegalStateException("The database returned no generated id for the timestamp client.");
        }
        return new Issued(new TsaClient(String.valueOf(number.longValue()), label), key);
    }

    /** Revokes a client; false when it is unknown or already revoked. */
    public boolean revoke(String id) {
        Long number = number(id);
        return number != null
            && jdbc.update("UPDATE " + TABLE + " SET revoked = ? WHERE id = ? AND revoked = 0", clock.millis(), number) > 0;
    }

    @Override
    public Optional<TsaClient> authenticate(String key) {
        if (key == null || key.isEmpty()) {
            return Optional.empty();
        }
        List<TsaClient> found = jdbc.query("SELECT id, label FROM " + TABLE + " WHERE key_hash = ? AND revoked = 0",
            (rs, row) -> new TsaClient(String.valueOf(rs.getLong("id")), rs.getString("label")), TsaClientKeys.hash(key));
        return found.stream().findFirst();
    }

    @Override
    public void used(TsaClient client) {
        Long number = number(client.id());
        if (number != null) {
            jdbc.update("UPDATE " + TABLE + " SET last_used = ?, uses = uses + 1 WHERE id = ?", clock.millis(), number);
        }
    }

    private static Long number(String id) {
        try {
            return Long.valueOf(id);
        } catch (NumberFormatException e) {
            return null;
        }
    }
}
