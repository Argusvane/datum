package com.argusvane.datum.forms.web;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.concurrent.ForkJoinPool;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.context.annotation.Bean;
import reactor.core.scheduler.Scheduler;

/**
 * The WebFlux handlers take the application's {@code Scheduler} bean when it defines exactly one, instead of Reactor's
 * elastic scheduler: the blocking work of a request (here, the public copy and the repository read) is submitted to it.
 */
@SpringBootTest(classes = {FormsFluxTestApp.class, FluxFormsSchedulerTest.AppScheduler.class}, webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
    "datum.web.api.endpoints.definition=true",
    "spring.main.web-application-type=reactive"})
class FluxFormsSchedulerTest {

    static final AtomicInteger SUBMITTED = new AtomicInteger();

    @TestConfiguration(proxyBeanMethods = false)
    static class AppScheduler {

        @Bean
        Scheduler applicationScheduler() {
            return reactor.core.scheduler.Schedulers.fromExecutor(task -> {
                SUBMITTED.incrementAndGet();
                ForkJoinPool.commonPool().execute(task);
            });
        }
    }

    @LocalServerPort
    int port;

    @Test
    void theHandlerRunsItsBlockingWorkOnTheApplicationsScheduler() {
        int before = SUBMITTED.get();
        Reply plain = FluxTransport.get(port, "/api/forms/plain/definition");
        assertThat(plain.status()).isEqualTo(200);
        assertThat(SUBMITTED.get()).as("the request's work went through the application's scheduler").isGreaterThan(before);
    }
}
