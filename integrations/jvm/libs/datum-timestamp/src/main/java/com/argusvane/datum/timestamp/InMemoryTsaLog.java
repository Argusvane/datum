package com.argusvane.datum.timestamp;

import com.argusvane.datum.core.DatumStartupCheck;
import java.time.Clock;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.Iterator;
import java.util.List;
import java.util.Objects;

/**
 * The timestamp server's log and serial allocator in memory: increasing serials for as long as the object lives,
 * and the latest records kept (a bounded window; the count is of every token).
 *
 * <p>RFC 3161 section 2.4.2 wants a serial unique among every token one TSA issues, which a database store takes from a
 * row id that survives restarts. Memory does not survive them, so by default the first serial is
 * the clock's epoch milliseconds times 1000 when the log is made: a process started later starts above every serial
 * an earlier one could have reached unless it issued more than a thousand tokens a millisecond, or the clock went
 * back between the two. That is a guard for a single host, not a guarantee: a host keeping tokens says so at
 * startup and uses a durable allocator. Tests that want serials 1, 2, 3 name the first serial.
 */
public final class InMemoryTsaLog implements TsaSerialAllocator, TsaLog {

    /**
     * The start-up WARN when the serial allocator in use is this one (integrations/jvm/README.md "Libraries and bindings"; the Spring auto-configuration wrote it when it made the bean before), under {@code datum.tsa}.
     */
    public static DatumStartupCheck startupCheck(TsaSerialAllocator allocator) {
        return () -> allocator instanceof InMemoryTsaLog
            ? List.of(DatumStartupCheck.Notice.warn("datum.tsa", "The timestamp server takes serial numbers from memory: they are "
                + "seeded from the clock (the epoch milliseconds times 1000) and unique only within this host, so a second node, a clock "
                + "set back or more than 1000 tokens a millisecond could repeat one. Add spring-jdbc and a DataSource and run "
                + "META-INF/datum/db/migration/<dialect>/V300__datum_timestamp.sql so datum.tsa uses the datum_tsa_log table "
                + "(serialAllocator: jdbc), or define a TsaSerialAllocator bean."))
            : List.of();
    }

    private final Clock clock;
    private final int keep;
    private final Deque<TsaLogRecord> records = new ArrayDeque<>();
    private long next;
    private long count;

    /** A log keeping the latest 1000 records, its serials seeded from the clock. */
    public InMemoryTsaLog(Clock clock) {
        this(clock, 1000);
    }

    /** A log keeping the latest records, its serials seeded from the clock. */
    public InMemoryTsaLog(Clock clock, int keep) {
        this(clock, keep, seed(clock));
    }

    /**
     * A log whose first serial is given (tests; a host that knows the last serial it issued).
     *
     * @param firstSerial the first serial handed out, at least 1
     */
    public InMemoryTsaLog(Clock clock, int keep, long firstSerial) {
        this.clock = Objects.requireNonNull(clock, "clock");
        if (keep < 1) {
            throw new IllegalArgumentException("keep must be positive");
        }
        if (firstSerial < 1) {
            throw new IllegalArgumentException("the first serial must be at least 1");
        }
        this.keep = keep;
        this.next = firstSerial;
    }

    private static long seed(Clock clock) {
        return Math.max(1, Objects.requireNonNull(clock, "clock").millis()) * 1000;
    }

    @Override
    public synchronized long allocate(TsaLogEntry entry) {
        Objects.requireNonNull(entry, "entry");
        if (next == Long.MAX_VALUE) {
            throw new IllegalStateException("the serials are spent");
        }
        long serial = next++;
        records.addFirst(new TsaLogRecord(serial, clock.instant(), entry));
        if (records.size() > keep) {
            records.removeLast();
        }
        count++;
        return serial;
    }

    @Override
    public synchronized List<TsaLogRecord> recent(int limit) {
        List<TsaLogRecord> out = new ArrayList<>();
        Iterator<TsaLogRecord> it = records.iterator();
        while (it.hasNext() && out.size() < limit) {
            out.add(it.next());
        }
        return out;
    }

    @Override
    public synchronized long count() {
        return count;
    }
}
