package com.argusvane.datum.timestamp.spring;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;

class InMemoryTsaFloodTest {

    private final AtomicReference<Instant> now = new AtomicReference<>(Instant.parse("2026-10-15T12:00:00Z"));
    private final Clock clock = new Clock() {
        @Override
        public java.time.ZoneId getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(java.time.ZoneId zone) {
            return this;
        }

        @Override
        public Instant instant() {
            return now.get();
        }
    };

    @Test
    void anIdentifierMayMakeTheLimitWithinTheWindowThenIsRefusedUntilItPasses() {
        InMemoryTsaFlood flood = new InMemoryTsaFlood(clock);

        assertThat(flood.acquire("e", 2, 60, "a")).isTrue();
        assertThat(flood.acquire("e", 2, 60, "a")).isTrue();
        assertThat(flood.acquire("e", 2, 60, "a")).isFalse();
        assertThat(flood.acquire("e", 2, 60, "b")).as("another identifier").isTrue();
        assertThat(flood.acquire("f", 2, 60, "a")).as("another event").isTrue();

        now.set(now.get().plus(Duration.ofSeconds(61)));
        assertThat(flood.acquire("e", 2, 60, "a")).as("the window passed").isTrue();
    }

    @Test
    void isAllowedAndRegisterCountEventsInTheWindow() {
        InMemoryTsaFlood flood = new InMemoryTsaFlood(clock);

        assertThat(flood.isAllowed("k", 1, 3600, "ip")).isTrue();
        flood.register("k", 3600, "ip");
        assertThat(flood.isAllowed("k", 1, 3600, "ip")).isFalse();
        assertThat(flood.isAllowed("k", 0, 3600, "other")).as("a limit of none allows nothing").isFalse();
    }

    @Test
    void theTableStaysBounded() {
        InMemoryTsaFlood flood = new InMemoryTsaFlood(clock);
        for (int i = 0; i < InMemoryTsaFlood.MAX_KEYS + 10; i++) {
            flood.register("e", 3600, "ip" + i);
        }

        // The newest identifier is counted; one old list made room for each.
        assertThat(flood.isAllowed("e", 1, 3600, "ip" + (InMemoryTsaFlood.MAX_KEYS + 9))).isFalse();
    }

    @Test
    void aFullTableForgetsOneListNeverTheFailedKeyOrClientCounts() {
        InMemoryTsaFlood flood = new InMemoryTsaFlood(clock);
        flood.register("datum.tsa_key_failed", 3600, "attacker");
        assertThat(flood.acquire("datum.tsa_client", 1, 3600, "client:1")).isTrue();
        for (int i = 0; i < InMemoryTsaFlood.MAX_KEYS + 100; i++) {
            flood.acquire("datum.tsa", 1, 3600, "ip" + i);
        }

        assertThat(flood.isAllowed("datum.tsa_key_failed", 1, 3600, "attacker")).as("the lockout survives other traffic").isFalse();
        assertThat(flood.acquire("datum.tsa_client", 1, 3600, "client:1")).as("the client count survives").isFalse();
        assertThat(flood.acquire("datum.tsa", 1, 3600, "ip" + (InMemoryTsaFlood.MAX_KEYS + 99))).as("the newest open count is kept").isFalse();
    }
}
