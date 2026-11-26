package com.argusvane.datum.timestamp.spring;

import com.argusvane.datum.timestamp.web.TsaFlood;

import java.time.Clock;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Counts flood events in memory: one list of times per event and identifier, pruned as it is read. Bounded: the
 * events are kept in three tables (failed keys, per-client counts, everything else, which is the open per-address
 * count), each holding at most {@link #MAX_KEYS} identifiers. A full table drops its expired lists first and then
 * only the one list that would expire soonest; it is never cleared, and traffic that fills the open table cannot
 * touch the failed-key or client counters (the lockout would otherwise be a thing an attacker could reset by
 * rotating addresses). An attacker who rotates
 * addresses inside the failed-key table can still push out the oldest entries there; that is the price of a heap
 * that never grows. Per process only; a cluster needs a shared {@link TsaFlood}.
 *
 * <p>The development default of the binding (framework-first): the library keeps the {@link TsaFlood}
 * contract, and the binding supplies this counter when the application defines none, with the WARN that it counts
 * per instance. Rate limiting is the framework's job; an application that needs one limit across instances supplies a shared TsaFlood bean.
 */
public final class InMemoryTsaFlood implements TsaFlood {

    /** Most identifiers remembered at once. */
    static final int MAX_KEYS = 50_000;

    private final Clock clock;
    private final Map<String, Deque<long[]>> failedKeys = new ConcurrentHashMap<>();
    private final Map<String, Deque<long[]>> clientCounts = new ConcurrentHashMap<>();
    private final Map<String, Deque<long[]>> openCounts = new ConcurrentHashMap<>();

    public InMemoryTsaFlood(Clock clock) {
        this.clock = Objects.requireNonNull(clock, "clock");
    }

    @Override
    public boolean isAllowed(String event, int limit, long windowSeconds, String identifier) {
        Deque<long[]> hits = tableOf(event).get(key(event, identifier));
        if (hits == null) {
            return limit > 0;
        }
        synchronized (hits) {
            prune(hits);
            return hits.size() < limit;
        }
    }

    @Override
    public void register(String event, long windowSeconds, String identifier) {
        Deque<long[]> hits = list(event, identifier);
        synchronized (hits) {
            prune(hits);
            hits.addLast(new long[] {clock.millis() + windowSeconds * 1000});
        }
    }

    @Override
    public boolean acquire(String event, int limit, long windowSeconds, String identifier) {
        Deque<long[]> hits = list(event, identifier);
        synchronized (hits) {
            prune(hits);
            if (hits.size() >= limit) {
                return false;
            }
            hits.addLast(new long[] {clock.millis() + windowSeconds * 1000});
            return true;
        }
    }

    private Map<String, Deque<long[]>> tableOf(String event) {
        if (event.startsWith(TsaFlood.KEY_EVENT)) {
            return failedKeys;
        }
        return event.startsWith(TsaFlood.CLIENT_EVENT) ? clientCounts : openCounts;
    }

    private Deque<long[]> list(String event, String identifier) {
        Map<String, Deque<long[]>> table = tableOf(event);
        String key = key(event, identifier);
        Deque<long[]> existing = table.get(key);
        if (existing != null) {
            return existing;
        }
        if (table.size() >= MAX_KEYS) {
            // One thread makes room at a time; the others find it made.
            synchronized (table) {
                if (table.size() >= MAX_KEYS) {
                    makeRoom(table);
                }
            }
        }
        return table.computeIfAbsent(key, k -> new ArrayDeque<>());
    }

    /** Drops the expired lists, and if the table is still full, the single list whose newest hit expires first. */
    private void makeRoom(Map<String, Deque<long[]>> table) {
        long now = clock.millis();
        table.entrySet().removeIf(entry -> {
            synchronized (entry.getValue()) {
                entry.getValue().removeIf(expiry -> expiry[0] <= now);
                return entry.getValue().isEmpty();
            }
        });
        if (table.size() < MAX_KEYS) {
            return;
        }
        String soonest = null;
        long soonestExpiry = Long.MAX_VALUE;
        for (Map.Entry<String, Deque<long[]>> entry : table.entrySet()) {
            long newest;
            synchronized (entry.getValue()) {
                Deque<long[]> hits = entry.getValue();
                newest = hits.isEmpty() ? Long.MIN_VALUE : hits.peekLast()[0];
            }
            if (newest < soonestExpiry) {
                soonestExpiry = newest;
                soonest = entry.getKey();
            }
        }
        if (soonest != null) {
            table.remove(soonest);
        }
    }

    private void prune(Deque<long[]> hits) {
        long now = clock.millis();
        while (!hits.isEmpty() && hits.peekFirst()[0] <= now) {
            hits.pollFirst();
        }
    }

    private static String key(String event, String identifier) {
        return event + '|' + (identifier == null ? "" : identifier);
    }
}
