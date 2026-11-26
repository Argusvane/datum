package com.argusvane.datum.timestamp.spring;

import com.argusvane.datum.springweb.spring.DatumStoreJdbc;
import com.argusvane.datum.timestamp.TsaLogEntry;
import com.argusvane.datum.timestamp.TsaSerialAllocator;
import java.time.Clock;
import java.util.Objects;
import javax.sql.DataSource;

/**
 * Takes each token's serial number from the {@code datum_tsa_log} table: the serial is the row's generated id,
 * inserted before the token is signed (an auto-increment column). A restart, a second node on the same database or a failed signing never reuses a
 * serial (RFC 3161 section 2.4.2). The table comes from {@code META-INF/datum/db/migration/<dialect>/V300__datum_timestamp.sql}
 * (shipped by datum-timestamp, kept in integrations/shared); the application owns the schema, so this class never
 * creates it.
 *
 * <p>On Spring's JDBC: the insert is a transaction of
 * its own ({@link DatumStoreJdbc}'s rule, {@code PROPAGATION_REQUIRES_NEW}), committed before {@link #allocate} returns
 * and so before the token is signed, whatever the pool's auto-commit and whether or not the caller is inside a
 * transaction of its own (a serial is never given back, even when that transaction rolls back).
 */
public final class JdbcTsaSerialAllocator implements TsaSerialAllocator {

    /** The table the migration scripts create. */
    public static final String TABLE = "datum_tsa_log";

    private static final String INSERT = "INSERT INTO " + TABLE
        + " (created, gen_time, algorithm, imprint, policy, fingerprint, client, channel) VALUES (?, ?, ?, ?, ?, ?, ?, ?)";

    private final DatumStoreJdbc jdbc;
    private final Clock clock;

    public JdbcTsaSerialAllocator(DataSource dataSource) {
        this(DatumStoreJdbc.of(dataSource), Clock.systemUTC());
    }

    public JdbcTsaSerialAllocator(DataSource dataSource, Clock clock) {
        this(DatumStoreJdbc.of(dataSource), clock);
    }

    public JdbcTsaSerialAllocator(DatumStoreJdbc jdbc, Clock clock) {
        this.jdbc = Objects.requireNonNull(jdbc, "jdbc");
        this.clock = Objects.requireNonNull(clock, "clock");
    }

    @Override
    public long allocate(TsaLogEntry entry) {
        Objects.requireNonNull(entry, "entry");
        long created = clock.millis();
        Object id = jdbc.insert(INSERT, created, entry.genTime(), entry.algorithm(), entry.imprint(), entry.policy(), entry.fingerprint(),
            entry.client(), entry.channel());
        if (id == null) {
            throw new IllegalStateException("The database returned no generated id for the timestamp log row.");
        }
        if (!(id instanceof Number number) || number.longValue() < 1) {
            throw new IllegalStateException("The database returned no usable serial for the timestamp log row: " + id);
        }
        return number.longValue();
    }
}
