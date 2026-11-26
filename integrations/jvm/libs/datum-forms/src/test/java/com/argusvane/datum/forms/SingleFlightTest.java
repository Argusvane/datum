package com.argusvane.datum.forms;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

/** The bounded single-flight cache behind the definition service's verdicts and public copies. */
class SingleFlightTest {

    @Test
    void aValueIsComputedOnceAndThenServedFromTheCache() {
        SingleFlight<String> cache = new SingleFlight<>(4);
        AtomicInteger runs = new AtomicInteger();
        assertThat(cache.get("k", () -> "v" + runs.incrementAndGet())).isEqualTo("v1");
        assertThat(cache.get("k", () -> "v" + runs.incrementAndGet())).isEqualTo("v1");
        assertThat(runs).hasValue(1);
    }

    @Test
    void concurrentRequestsForOneNewKeyShareOneComputation() throws Exception {
        SingleFlight<String> cache = new SingleFlight<>(4);
        AtomicInteger runs = new AtomicInteger();
        CountDownLatch inside = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        ExecutorService pool = Executors.newFixedThreadPool(8);
        try {
            Future<String> first = pool.submit(() -> cache.get("k", () -> {
                runs.incrementAndGet();
                inside.countDown();
                try {
                    release.await(10, TimeUnit.SECONDS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
                return "once";
            }));
            assertThat(inside.await(10, TimeUnit.SECONDS)).isTrue();
            List<Future<String>> waiters = new ArrayList<>();
            for (int i = 0; i < 6; i++) {
                waiters.add(pool.submit(() -> cache.get("k", () -> "again " + runs.incrementAndGet())));
            }
            Thread.sleep(100);
            release.countDown();
            assertThat(first.get(10, TimeUnit.SECONDS)).isEqualTo("once");
            for (Future<String> waiter : waiters) {
                assertThat(waiter.get(10, TimeUnit.SECONDS)).isEqualTo("once");
            }
            assertThat(runs).as("one run for seven requests").hasValue(1);
        } finally {
            pool.shutdownNow();
        }
    }

    @Test
    void aFailureIsNotCachedSoTheNextRequestTriesAgain() {
        SingleFlight<String> cache = new SingleFlight<>(4);
        AtomicInteger runs = new AtomicInteger();
        assertThatThrownBy(() -> cache.get("k", () -> {
            runs.incrementAndGet();
            throw new IllegalStateException("busy");
        })).isInstanceOf(IllegalStateException.class).hasMessage("busy");
        assertThat(cache.get("k", () -> "recovered")).isEqualTo("recovered");
        assertThat(runs).hasValue(1);
    }

    @Test
    void aWaiterReceivesTheComputingRequestsFailureAsIs() throws Exception {
        SingleFlight<String> cache = new SingleFlight<>(4);
        CountDownLatch inside = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            Future<String> first = pool.submit(() -> cache.get("k", () -> {
                inside.countDown();
                try {
                    release.await(10, TimeUnit.SECONDS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
                throw new IllegalArgumentException("no slot");
            }));
            assertThat(inside.await(10, TimeUnit.SECONDS)).isTrue();
            Future<String> waiter = pool.submit(() -> cache.get("k", () -> "mine"));
            Thread.sleep(100);
            release.countDown();
            assertThatThrownBy(() -> first.get(10, TimeUnit.SECONDS)).hasCauseInstanceOf(IllegalArgumentException.class);
            assertThatThrownBy(() -> waiter.get(10, TimeUnit.SECONDS)).hasCauseInstanceOf(IllegalArgumentException.class);
        } finally {
            pool.shutdownNow();
        }
    }

    @Test
    void theCacheIsBounded() {
        SingleFlight<Integer> cache = new SingleFlight<>(2);
        AtomicInteger runs = new AtomicInteger();
        for (int round = 0; round < 3; round++) {
            for (int key = 0; key < 50; key++) {
                cache.get("k" + key, runs::incrementAndGet);
            }
        }
        assertThat(runs.get()).as("evicted keys are computed again").isGreaterThan(50);
        assertThatThrownBy(() -> new SingleFlight<String>(0)).isInstanceOf(IllegalArgumentException.class);
    }
}
