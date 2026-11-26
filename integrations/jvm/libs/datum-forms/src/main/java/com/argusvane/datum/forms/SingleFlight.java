package com.argusvane.datum.forms;

import com.github.benmanes.caffeine.cache.AsyncCache;
import com.github.benmanes.caffeine.cache.Caffeine;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.function.Supplier;

/**
 * A bounded cache whose misses are single-flight: concurrent requests for one new key share one computation
 * instead of each starting a sandbox run (a definition hash seen for the first time by many requests at once
 * costs one guest, not many).
 *
 * <p>Built on Caffeine's {@link AsyncCache}, with the first caller computing on its own thread: the future is
 * registered at once (the mapping function returns instantly, so no map bin is held during a run) and completed
 * when the computation ends. Other callers wait on it. A computation that fails removes its entry (Caffeine
 * does), so the next request tries again, but every caller that was already waiting receives that same failure:
 * a {@code BUSY} refusal of the computing request is shared with its waiters rather than retried by each of them.
 *
 * @param <V> the cached value
 */
final class SingleFlight<V> {

    private final AsyncCache<String, V> cache;

    SingleFlight(int maxEntries) {
        if (maxEntries < 1) {
            throw new IllegalArgumentException("A cache holds at least one entry.");
        }
        // Maintenance (the eviction that keeps the bound) runs on the writing thread, not on the common pool:
        // a bound a reader cannot observe until some other thread gets around to it is no bound, and a test
        // that fills the cache past it would see every key still present on a one-core runner.
        this.cache = Caffeine.newBuilder().maximumSize(maxEntries).executor(Runnable::run).buildAsync();
    }

    /** The cached value, else the one {@code compute} makes (once for all concurrent callers). */
    V get(String key, Supplier<V> compute) {
        CompletableFuture<V> mine = new CompletableFuture<>();
        CompletableFuture<V> flight = cache.get(key, (k, executor) -> mine);
        if (flight == mine) {
            try {
                mine.complete(compute.get());
            } catch (RuntimeException | Error e) {
                mine.completeExceptionally(e);
                throw e;
            }
            return mine.join();
        }
        try {
            return flight.join();
        } catch (CompletionException e) {
            Throwable cause = e.getCause();
            if (cause instanceof RuntimeException runtime) {
                throw runtime;
            }
            if (cause instanceof Error error) {
                throw error;
            }
            throw e;
        }
    }
}
