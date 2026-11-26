package com.argusvane.datum.timestamp.spring;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.timestamp.TsaLogEntry;
import java.time.Clock;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;

/**
 * The serial allocator, the log and the client store with the shipped script on a
 * real PostgreSQL and a real MySQL. The serial is the generated row id (PostgreSQL returns generated keys differently from H2
 * and MySQL), so what is proved is that concurrent allocations each get their own serial and the log reads them back.
 * Tagged {@code containers}: it runs in the {@code containers} profile and is skipped where Docker does not answer.
 */
abstract class TsaStoresContainersContract {

    /** The clean database of the subclass's container (the container is started once for the class, never passed as an argument). */
    protected abstract DataSource database() throws Exception;

    private static TsaLogEntry entry(String imprint) {
        return new TsaLogEntry("20261015120000Z", "sha256", imprint, "2.25.1", "f".repeat(64), null, "http");
    }

    @Test
    void serialsAreTheGeneratedIdAndTheLogReadsThemBack() throws Exception {
        DataSource source = database();
        JdbcTsaSerialAllocator allocator = new JdbcTsaSerialAllocator(source, Clock.systemUTC());
        JdbcTsaLog log = new JdbcTsaLog(source);

        long first = allocator.allocate(entry("aa"));
        long second = allocator.allocate(entry("bb"));

        assertThat(second).isGreaterThan(first);
        assertThat(log.count()).isEqualTo(2);
        assertThat(log.recent(10)).extracting(record -> record.serial()).containsExactly(second, first);
    }

    @Test
    void concurrentAllocationsEachGetTheirOwnSerial() throws Exception {
        DataSource source = database();
        JdbcTsaSerialAllocator allocator = new JdbcTsaSerialAllocator(source, Clock.systemUTC());
        int threads = 8;
        int each = 10;
        CyclicBarrier start = new CyclicBarrier(threads);
        ExecutorService pool = Executors.newFixedThreadPool(threads);
        List<Future<List<Long>>> runs = new ArrayList<>();
        for (int t = 0; t < threads; t++) {
            int worker = t;
            runs.add(pool.submit(() -> {
                start.await();
                List<Long> serials = new ArrayList<>();
                for (int i = 0; i < each; i++) {
                    serials.add(allocator.allocate(entry("w" + worker + "-" + i)));
                }
                return serials;
            }));
        }
        Set<Long> all = new HashSet<>();
        for (Future<List<Long>> run : runs) {
            all.addAll(run.get());
        }
        pool.shutdown();
        assertThat(all).as("no serial was handed out twice").hasSize(threads * each);
        assertThat(new JdbcTsaLog(source).count()).isEqualTo(threads * each);
    }

    @Test
    void aClientKeyIsIssuedAuthenticatedAndRevoked() throws Exception {
        DataSource source = database();
        JdbcTsaClientStore clients = new JdbcTsaClientStore(source, Clock.systemUTC());

        JdbcTsaClientStore.Issued issued = clients.add("the seal service");

        assertThat(clients.authenticate(issued.key())).isPresent();
        assertThat(clients.authenticate("not-the-key")).isEmpty();
        assertThat(clients.revoke(issued.client().id())).isTrue();
        assertThat(clients.authenticate(issued.key())).isEmpty();
    }
}
