package com.argusvane.datum.webauthn.spring;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;

/** The anonymous-passkey purge on the application's TaskScheduler, and nothing without one. */
class PasskeyPurgeScheduleTest {

    @Test
    void aSchedulerRunsThePurgeAndTheShutdownStopsIt() throws Exception {
        ThreadPoolTaskScheduler scheduler = new ThreadPoolTaskScheduler();
        scheduler.initialize();
        try {
            CountDownLatch ran = new CountDownLatch(1);
            PasskeyPurgeSchedule schedule = new PasskeyPurgeSchedule(ran::countDown, scheduler);
            assertThat(schedule.scheduled()).isFalse();
            schedule.afterSingletonsInstantiated();
            assertThat(schedule.scheduled()).isTrue();
            assertThat(ran.await(5, TimeUnit.SECONDS)).as("the purge ran on the scheduler").isTrue();
            schedule.destroy();
        } finally {
            scheduler.shutdown();
        }
    }

    @Test
    void withoutASchedulerNothingIsScheduledAndTheRegistrationPurgeStaysTheFallback() {
        AtomicInteger runs = new AtomicInteger();
        PasskeyPurgeSchedule schedule = new PasskeyPurgeSchedule(runs::incrementAndGet, null);
        schedule.afterSingletonsInstantiated();
        schedule.destroy();
        assertThat(schedule.scheduled()).isFalse();
        assertThat(runs).hasValue(0);
    }
}
