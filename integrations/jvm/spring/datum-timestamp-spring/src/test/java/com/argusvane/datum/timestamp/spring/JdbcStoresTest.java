package com.argusvane.datum.timestamp.spring;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.timestamp.FailingSignature;
import com.argusvane.datum.timestamp.TimestampQuery;
import com.argusvane.datum.timestamp.TimestampReply;
import com.argusvane.datum.timestamp.TsaClient;
import com.argusvane.datum.timestamp.TsaClientKeys;
import com.argusvane.datum.timestamp.TsaLogEntry;
import com.argusvane.datum.timestamp.TsaLogRecord;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.stream.Collectors;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.jdbc.core.JdbcTemplate;

/** The JDBC log, serial allocator and client store, on the shipped migration of each dialect (H2 in its modes). */
class JdbcStoresTest {

    private static final Clock CLOCK = Clock.fixed(Instant.parse("2026-10-15T12:00:00Z"), ZoneOffset.UTC);

    private static TsaLogEntry entry(String imprint, String client) {
        return new TsaLogEntry("20261015120000Z", "sha256", imprint, "2.25.1", "f".repeat(64), client, "http");
    }

    @ParameterizedTest
    @ValueSource(strings = {"h2", "postgresql", "mysql"})
    void theSerialIsTheRowIdTakenBeforeSigningAndTheLogReadsItBack(String dialect) {
        JdbcTemplate jdbc = Migrations.database(dialect);
        JdbcTsaSerialAllocator allocator = new JdbcTsaSerialAllocator(jdbc.getDataSource(), CLOCK);
        JdbcTsaLog log = new JdbcTsaLog(jdbc.getDataSource());

        long first = allocator.allocate(entry("aa", null));
        long second = allocator.allocate(entry("bb", "7"));

        assertThat(first).isEqualTo(1);
        assertThat(second).isEqualTo(2);
        assertThat(log.count()).isEqualTo(2);
        List<TsaLogRecord> recent = log.recent(10);
        assertThat(recent).extracting(TsaLogRecord::serial).containsExactly(2L, 1L);
        assertThat(recent.get(0).entry()).isEqualTo(entry("bb", "7"));
        assertThat(recent.get(0).created()).isEqualTo(CLOCK.instant());
        assertThat(recent.get(1).entry().client()).isNull();
        assertThat(log.recent(1)).extracting(TsaLogRecord::serial).containsExactly(2L);
        assertThat(log.recent(0)).isEmpty();
    }

    @Test
    void aSerialIsTakenBeforeSigningAndNeverReusedWhenSigningFails() throws Exception {
        JdbcTemplate jdbc = Migrations.database("h2");
        JdbcTsaLog log = new JdbcTsaLog(jdbc.getDataSource());
        byte[] query = TimestampQuery.forData("x".getBytes(java.nio.charset.StandardCharsets.UTF_8));

        FailingSignature.run(new JdbcTsaSerialAllocator(jdbc.getDataSource()), authority -> {
            TimestampReply failed = authority.respond(query, null);
            assertThat(failed.granted()).isFalse();
            assertThat(failed.status()).isEqualTo(503);
            assertThat(log.count()).as("the row was written before signing").isEqualTo(1);

            TimestampReply next = authority.respond(query, null);
            assertThat(next.granted()).isTrue();
            assertThat(next.issued().serial()).as("the failed serial is not reused").isEqualTo(2);
            assertThat(log.count()).isEqualTo(2);
        });
    }

    @Test
    void concurrentAllocationsNeverShareASerial() throws Exception {
        JdbcTemplate jdbc = Migrations.database("h2");
        JdbcTsaSerialAllocator allocator = new JdbcTsaSerialAllocator(jdbc.getDataSource());
        ExecutorService pool = Executors.newFixedThreadPool(8);
        try {
            List<Callable<Long>> jobs = java.util.stream.IntStream.range(0, 64).<Callable<Long>>mapToObj(i -> () -> allocator.allocate(entry("c" + i, null))).toList();
            Set<Long> serials = pool.invokeAll(jobs).stream().map(f -> {
                try {
                    return f.get();
                } catch (Exception e) {
                    throw new AssertionError(e);
                }
            }).collect(Collectors.toSet());
            assertThat(serials).hasSize(64);
        } finally {
            pool.shutdownNow();
        }
    }

    /**
     * The transaction rule (DatumStoreJdbc): a serial taken inside a transaction of the caller, under the
     * same transaction manager, is a transaction of its own, committed before allocate returns. The caller rolls back;
     * the serial stays taken and is never handed out again (RFC 3161 section 2.4.2).
     */
    @Test
    void aSerialSurvivesTheCallersRollback() {
        JdbcTemplate jdbc = Migrations.database("h2");
        javax.sql.DataSource source = jdbc.getDataSource();
        org.springframework.transaction.PlatformTransactionManager application = new org.springframework.jdbc.support.JdbcTransactionManager(source);
        JdbcTsaSerialAllocator allocator = new JdbcTsaSerialAllocator(
            com.argusvane.datum.springweb.spring.DatumStoreJdbc.of(source, application), CLOCK);
        long[] taken = new long[1];

        new org.springframework.transaction.support.TransactionTemplate(application).executeWithoutResult(status -> {
            taken[0] = allocator.allocate(entry("aa", null));
            status.setRollbackOnly();
        });

        assertThat(taken[0]).isEqualTo(1);
        assertThat(new JdbcTsaLog(source).count()).as("the row outlived the caller's rollback").isEqualTo(1);
        assertThat(allocator.allocate(entry("bb", null))).as("and its serial is not reused").isEqualTo(2);
    }

    @Test
    void aSecondAllocatorOnTheSameDatabaseContinuesTheSequence() {
        JdbcTemplate jdbc = Migrations.database("h2");
        new JdbcTsaSerialAllocator(jdbc.getDataSource()).allocate(entry("aa", null));

        assertThat(new JdbcTsaSerialAllocator(jdbc.getDataSource()).allocate(entry("bb", null))).isEqualTo(2);
    }

    @Test
    void theStoreNeverCreatesItsTable() {
        JdbcTemplate jdbc = new JdbcTemplate(new org.springframework.jdbc.datasource.DriverManagerDataSource("jdbc:h2:mem:" + java.util.UUID.randomUUID(), "sa", ""));

        org.assertj.core.api.Assertions.assertThatThrownBy(() -> new JdbcTsaSerialAllocator(jdbc.getDataSource()).allocate(entry("aa", null)))
            .isInstanceOf(org.springframework.dao.DataAccessException.class);
    }

    @ParameterizedTest
    @ValueSource(strings = {"h2", "postgresql", "mysql"})
    void clientsAreAddedAuthenticatedUsedAndRevoked(String dialect) {
        JdbcTemplate jdbc = Migrations.database(dialect);
        JdbcTsaClientStore store = new JdbcTsaClientStore(jdbc.getDataSource(), CLOCK);

        JdbcTsaClientStore.Issued issued = store.add("Acme");
        assertThat(issued.key()).startsWith(TsaClientKeys.PREFIX);
        assertThat(issued.client().label()).isEqualTo("Acme");
        Map<String, Object> row = jdbc.queryForMap("SELECT key_hash, key_hint, uses FROM datum_tsa_client");
        assertThat(row.get("key_hash")).isEqualTo(TsaClientKeys.hash(issued.key()));
        assertThat(row.get("key_hint")).isEqualTo(TsaClientKeys.hint(issued.key()));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM datum_tsa_client WHERE key_hash = ?", Integer.class, issued.key())).as("the key itself is never kept").isZero();

        assertThat(store.authenticate(issued.key())).contains(issued.client());
        assertThat(store.authenticate("dtsa_other")).isEmpty();
        assertThat(store.authenticate("")).isEmpty();

        store.used(issued.client());
        store.used(issued.client());
        assertThat(jdbc.queryForObject("SELECT uses FROM datum_tsa_client", Long.class)).isEqualTo(2);
        assertThat(jdbc.queryForObject("SELECT last_used FROM datum_tsa_client", Long.class)).isEqualTo(CLOCK.millis());

        assertThat(store.revoke(issued.client().id())).isTrue();
        assertThat(store.revoke(issued.client().id())).as("already revoked").isFalse();
        assertThat(store.revoke("not-a-number")).isFalse();
        assertThat(store.authenticate(issued.key())).as("a revoked key no longer works").isEmpty();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM datum_tsa_client", Integer.class)).as("the row stays").isEqualTo(1);
        store.used(new TsaClient("x", "unknown"));
    }

    @Test
    void everyDialectShipsBothTables() {
        for (String dialect : List.of("h2", "postgresql", "mysql")) {
            JdbcTemplate jdbc = Migrations.database(dialect);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM datum_tsa_log", Integer.class)).as(dialect).isZero();
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM datum_tsa_client", Integer.class)).as(dialect).isZero();
        }
    }
}
