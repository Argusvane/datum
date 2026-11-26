package com.argusvane.datum.timestamp.spring;

import com.argusvane.datum.springweb.spring.DatumStoreJdbc;
import com.argusvane.datum.timestamp.TsaLog;
import com.argusvane.datum.timestamp.TsaLogEntry;
import com.argusvane.datum.timestamp.TsaLogRecord;
import java.time.Instant;
import java.util.List;
import java.util.Objects;
import javax.sql.DataSource;

/**
 * Reads the timestamp server's log from the {@code datum_tsa_log} table that {@link JdbcTsaSerialAllocator}
 * writes: the latest tokens, newest first, and how many there are. Plain SQL with {@code setMaxRows}, so the same
 * statements run on H2, PostgreSQL and MySQL.
 *
 * <p>On Spring's JDBC ({@link DatumStoreJdbc}).
 */
public final class JdbcTsaLog implements TsaLog {

    private static final String SELECT = "SELECT id, created, gen_time, algorithm, imprint, policy, fingerprint, client, channel FROM "
        + JdbcTsaSerialAllocator.TABLE + " ORDER BY id DESC";

    private final DatumStoreJdbc jdbc;

    public JdbcTsaLog(DataSource dataSource) {
        this(DatumStoreJdbc.of(dataSource));
    }

    public JdbcTsaLog(DatumStoreJdbc jdbc) {
        this.jdbc = Objects.requireNonNull(jdbc, "jdbc");
    }

    @Override
    public List<TsaLogRecord> recent(int limit) {
        if (limit < 1) {
            return List.of();
        }
        return jdbc.query(SELECT, limit, (rs, row) -> new TsaLogRecord(rs.getLong("id"), Instant.ofEpochMilli(rs.getLong("created")),
            new TsaLogEntry(rs.getString("gen_time"), rs.getString("algorithm"), rs.getString("imprint"), rs.getString("policy"),
                rs.getString("fingerprint"), rs.getString("client"), rs.getString("channel"))));
    }

    @Override
    public long count() {
        return jdbc.number("SELECT COUNT(*) FROM " + JdbcTsaSerialAllocator.TABLE);
    }
}
