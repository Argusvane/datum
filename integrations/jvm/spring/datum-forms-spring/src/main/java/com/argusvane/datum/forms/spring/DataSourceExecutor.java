package com.argusvane.datum.forms.spring;

import java.util.concurrent.Executor;
import org.springframework.beans.factory.DisposableBean;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;

/**
 * The pool data-source calls run on, held in a bean that is deliberately NOT an {@link Executor}: Boot's
 * {@code applicationTaskExecutor} backs off when any {@code Executor} bean exists, and an {@code @Async} method with no named
 * executor would land on a unique one. Adding the forms binding must not change the application's threading, so the pool is
 * kept inside this holder, built and stopped by Spring's own {@link ThreadPoolTaskExecutor}.
 */
final class DataSourceExecutor implements DisposableBean {

    private final ThreadPoolTaskExecutor pool;

    /** @param pool an executor from Spring's builder that is not yet initialised */
    DataSourceExecutor(ThreadPoolTaskExecutor pool) {
        this.pool = pool;
        pool.initialize();
    }

    Executor executor() {
        return pool;
    }

    @Override
    public void destroy() {
        pool.destroy();
    }
}
