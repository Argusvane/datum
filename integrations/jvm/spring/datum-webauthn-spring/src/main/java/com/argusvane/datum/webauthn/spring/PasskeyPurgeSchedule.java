package com.argusvane.datum.webauthn.spring;

import java.time.Duration;
import java.util.concurrent.ScheduledFuture;
import org.springframework.beans.factory.DisposableBean;
import org.springframework.beans.factory.SmartInitializingSingleton;
import org.springframework.scheduling.TaskScheduler;

/**
 * Runs {@code PasskeysApi#purgeAnonymous()} hourly on the application's {@link TaskScheduler}. The purge is a
 * conditional delete in bounded batches, so a second node doing the same is harmless. With no scheduler it does
 * nothing: the registration path still purges.
 */
final class PasskeyPurgeSchedule implements SmartInitializingSingleton, DisposableBean {

    /** How long between two purges. */
    static final Duration EVERY = Duration.ofHours(1);

    private final Runnable purge;
    private final TaskScheduler scheduler;
    private volatile ScheduledFuture<?> task;

    PasskeyPurgeSchedule(Runnable purge, TaskScheduler scheduler) {
        this.purge = purge;
        this.scheduler = scheduler;
    }

    @Override
    public void afterSingletonsInstantiated() {
        if (scheduler != null) {
            task = scheduler.scheduleWithFixedDelay(purge, EVERY);
        }
    }

    /** Whether a timer is running (for tests). */
    boolean scheduled() {
        return task != null;
    }

    @Override
    public void destroy() {
        ScheduledFuture<?> running = task;
        if (running != null) {
            running.cancel(false);
        }
    }
}
