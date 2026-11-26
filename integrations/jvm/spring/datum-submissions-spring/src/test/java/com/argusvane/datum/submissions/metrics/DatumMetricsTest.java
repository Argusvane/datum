package com.argusvane.datum.submissions.metrics;

import com.argusvane.datum.sandbox.observation.SandboxRunMetrics;
import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.sandbox.wasi.Termination;
import com.argusvane.datum.forms.spring.DatumFormsAutoConfiguration;
import com.argusvane.datum.springweb.autoconfigure.DatumMetricsAutoConfiguration;
import com.argusvane.datum.springweb.autoconfigure.DatumWebAutoConfiguration;
import com.argusvane.datum.submissions.Fixtures;
import com.argusvane.datum.sandbox.runtime.TestRuntime;
import com.argusvane.datum.submissions.receiver.SubmissionReceiver;
import com.argusvane.datum.submissions.service.FormRef;
import com.argusvane.datum.submissions.service.SubmissionOutcome;
import com.argusvane.datum.submissions.service.SubmissionService;
import com.argusvane.datum.submissions.spi.SubmissionContext;
import com.argusvane.datum.submissions.spi.SubmissionRequest;
import com.argusvane.datum.sandbox.spring.DatumSandboxAutoConfiguration;
import com.argusvane.datum.submissions.spring.DatumSubmissionsAutoConfiguration;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.binder.MeterBinder;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;

/** The meters are registered and move: runs, submissions, throttled, rejected, active. */
class DatumMetricsTest {

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(DatumWebAutoConfiguration.class, DatumMetricsAutoConfiguration.class,
            DatumFormsAutoConfiguration.class, DatumSandboxAutoConfiguration.class, DatumSubmissionsAutoConfiguration.class))
        .withPropertyValues("datum.forms.locations=classpath:/datum-test-forms/*.json", "datum.runtime.warm-up-runs=0")
        .withBean(SimpleMeterRegistry.class, SimpleMeterRegistry::new);

    private static MeterRegistry bound(org.springframework.context.ApplicationContext context) {
        MeterRegistry registry = context.getBean(SimpleMeterRegistry.class);
        // Boot's metrics auto-configuration does this for an application; the test does it by hand.
        context.getBeansOfType(MeterBinder.class).values().forEach(binder -> binder.bindTo(registry));
        return registry;
    }

    private static byte[] body() {
        return Fixtures.delivered(Fixtures.envelope("contact", "1", "{\"name\":\"Ada\"}"));
    }

    @Test
    void runsSubmissionsAndGaugesAreRegisteredAndCounted() {
        runner.withBean(TestRuntime.class, TestRuntime::new).run(context -> {
            assertThat(context).hasNotFailed();
            MeterRegistry registry = bound(context);
            assertThat(registry.find("datum.runs.active").gauge()).isNotNull();
            assertThat(registry.find("datum.runs.slots").tag("program", "sandbox").gauge()).isNotNull();
            assertThat(registry.find("datum.runs.slots").tag("program", "pdf").gauge()).isNotNull();

            var answer = context.getBean(SubmissionReceiver.class).submit(SubmissionRequest.json(), body());
            assertThat(answer.body().path("status").stringValue()).isEqualTo("accepted");

            assertThat(registry.get("datum.runs").tag("program", "sandbox").tag("outcome", "exited").timer().count()).isEqualTo(1);
            assertThat(registry.get("datum.runs.wait").tag("program", "sandbox").timer().count()).isEqualTo(1);
            assertThat(registry.get("datum.submissions").tag("form", "contact").tag("status", "accepted").counter().count()).isEqualTo(1.0);
            assertThat(registry.get("datum.runs.active").gauge().value()).isZero();
        });
    }

    @Test
    void aStoppedRunIsTaggedWithItsTermination() {
        TestRuntime engine = new TestRuntime();
        engine.terminate = Termination.BUDGET;
        runner.withBean(TestRuntime.class, () -> engine).run(context -> {
            MeterRegistry registry = bound(context);
            try {
                context.getBean(SubmissionReceiver.class).submit(SubmissionRequest.json(), body());
            } catch (RuntimeException expected) {
                // The answer is not the point here.
            }
            assertThat(registry.get("datum.runs").tag("outcome", "budget").timer().count()).isEqualTo(1);
        });
    }

    @Test
    void aThrottledRequestCountsAndRunsNothing() {
        TestRuntime engine = new TestRuntime();
        runner.withPropertyValues("datum.web.throttle.limit=1").withBean(TestRuntime.class, () -> engine).run(context -> {
            MeterRegistry registry = bound(context);
            SubmissionReceiver receiver = context.getBean(SubmissionReceiver.class);
            SubmissionRequest from = new SubmissionRequest("application/json", Map.of(), "10.0.0.7", null);
            receiver.submit(from, body());
            int runs = engine.validations();
            org.assertj.core.api.Assertions.assertThatThrownBy(() -> receiver.submit(from, body()))
                .isInstanceOf(com.argusvane.datum.submissions.receiver.ThrottledException.class);
            assertThat(engine.validations()).isEqualTo(runs);
            assertThat(registry.get("datum.throttled").tag("kind", "submit").counter().count()).isEqualTo(1.0);
        });
    }

    /**
     * {@code datum.runs.rejected{reason=busy}} is counted by the slots themselves, so a busy refusal of a
     * caller that never reaches the HTTP error mapper (a queue consumer calling the service) is counted, once; the meter's
     * name and tag are the ones the error-mapper counter registered before.
     */
    @Test
    void aBusyRefusalIsCountedOnEveryChannelWithoutTheMapper() {
        TestRuntime engine = new TestRuntime();
        runner.withPropertyValues("datum.runtime.validation.concurrency=1", "datum.runtime.validation.wait=0s")
            .withBean(TestRuntime.class, () -> engine).run(context -> {
                MeterRegistry registry = bound(context);
                SubmissionService service = context.getBean(SubmissionService.class);
                engine.hold = new java.util.concurrent.CountDownLatch(1);
                engine.holding = new java.util.concurrent.CountDownLatch(1);
                java.util.concurrent.ExecutorService first = java.util.concurrent.Executors.newSingleThreadExecutor();
                try {
                    java.util.concurrent.Future<?> held = first.submit(() -> service.submit(FormRef.fromDocument(),
                        Fixtures.envelope("contact", "1", "{\"name\":\"Ada\"}"), SubmissionContext.of(SubmissionContext.BUS).withSubmissionKey(java.util.UUID.randomUUID().toString())));
                    assertThat(engine.holding.await(5, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
                    SubmissionOutcome busy = service.submit(FormRef.fromDocument(), Fixtures.envelope("contact", "1", "{\"name\":\"Bo\"}"),
                        SubmissionContext.of(SubmissionContext.BUS).withSubmissionKey(java.util.UUID.randomUUID().toString()));
                    assertThat(busy).isInstanceOfSatisfying(SubmissionOutcome.Unavailable.class,
                        unavailable -> assertThat(unavailable.code()).isEqualTo("server.busy"));
                    engine.hold.countDown();
                    held.get(5, java.util.concurrent.TimeUnit.SECONDS);
                } finally {
                    first.shutdownNow();
                }
                assertThat(registry.get("datum.runs.rejected").tag("reason", "busy").counter().count()).isEqualTo(1.0);
                assertThat(registry.get("datum.runs.rejected").counter().getId().getTags()).hasSize(1);
                assertThat(context).as("the error-mapper counter is gone").doesNotHaveBean("datumBusyRefusalCounter");
            });
    }

    @Test
    void withoutMicrometerTheBeansAreNotDefined() {
        runner.withBean(TestRuntime.class, TestRuntime::new)
            .withClassLoader(new org.springframework.boot.test.context.FilteredClassLoader("io.micrometer"))
            .run(context -> assertThat(context).hasNotFailed().doesNotHaveBean(SandboxRunMetrics.class).doesNotHaveBean(SubmissionMetrics.class));
    }
}
