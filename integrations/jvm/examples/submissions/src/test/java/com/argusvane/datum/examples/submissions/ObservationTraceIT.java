package com.argusvane.datum.examples.submissions;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.starter.test.DatumTck;
import com.argusvane.datum.tck.HostContract;
import com.argusvane.datum.tck.HostTarget;
import com.argusvane.datum.tck.Reply;
import com.argusvane.datum.tck.TckFixtures;
import io.micrometer.observation.ObservationHandler;
import io.micrometer.observation.ObservationRegistry;
import io.micrometer.tracing.handler.DefaultTracingObservationHandler;
import io.micrometer.tracing.test.simple.SimpleSpan;
import io.micrometer.tracing.test.simple.SimpleTracer;
import java.time.Duration;
import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.context.annotation.Bean;

/**
 * Observation traces with the REAL runtime and an application that has an
 * {@code ObservationRegistry} (the example's actuator) and a tracer (Micrometer's in-memory {@link SimpleTracer} behind
 * the standard tracing handler, what an OpenTelemetry or Brave bridge would be): a submission's spans are under the HTTP
 * request's trace. The server span of {@code POST /api/submissions} is the parent of {@code datum.submission}, which is the
 * parent of the sandbox's {@code datum.sandbox.run}; all three share the request's trace id, and the form key is a tag of
 * the submission's span. Nothing in the application names Datum's observations.
 */
@Tag("real-runtime")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = "datum.runtime.warm-up-runs=1")
class ObservationTraceIT implements HostContract {

    @TestConfiguration(proxyBeanMethods = false)
    static class Tracing {

        @Bean
        SimpleTracer simpleTracer() {
            return new SimpleTracer();
        }

        /** Spring Boot registers every ObservationHandler bean with the application's registry. */
        @Bean
        ObservationHandler<?> tracingObservationHandler(SimpleTracer tracer) {
            return new DefaultTracingObservationHandler(tracer);
        }
    }

    @LocalServerPort
    int port;

    @Autowired
    SimpleTracer tracer;

    @Autowired
    ObservationRegistry registry;

    @Override
    public HostTarget target() {
        return DatumTck.local(port);
    }

    private Optional<SimpleSpan> span(String tag, String value) {
        return tracer.getSpans().stream().filter(span -> value.equals(span.getTags().get(tag))).reduce((first, last) -> last);
    }

    private Optional<SimpleSpan> server() {
        return tracer.getSpans().stream().filter(span -> "/api/submissions".equals(span.getTags().get("uri"))).reduce((first, last) -> last);
    }

    @Test
    void aSubmissionsSpansAreUnderTheHttpRequestsTrace() throws Exception {
        assertThat(registry.isNoop()).as("the application has a working ObservationRegistry").isFalse();

        Reply accepted = http().postJson(target().api("/submissions"), TckFixtures.delivered(TckFixtures.envelope("CTL-01")));
        assertThat(accepted.status()).as(accepted.toString()).isEqualTo(200);

        // The server span ends after the answer is written: wait for it.
        long end = System.nanoTime() + Duration.ofSeconds(5).toNanos();
        while (server().isEmpty() && System.nanoTime() < end) {
            Thread.sleep(25);
        }
        SimpleSpan request = server().orElseThrow(() -> new AssertionError("no server span: " + tracer.getSpans()));
        SimpleSpan submission = span("mode", "submit").orElseThrow(() -> new AssertionError("no datum.submission span: " + tracer.getSpans()));
        List<SimpleSpan> runs = tracer.getSpans().stream().filter(span -> "validate".equals(span.getTags().get("op"))).toList();
        assertThat(runs).as("the receiver's sandbox run").hasSize(1);
        SimpleSpan run = runs.get(0);

        assertThat(submission.getTraceId()).as("the request's trace").isEqualTo(request.getTraceId());
        assertThat(run.getTraceId()).isEqualTo(request.getTraceId());
        assertThat(submission.getParentId()).as("datum.submission under the server span").isEqualTo(request.getSpanId());
        assertThat(run.getParentId()).as("datum.sandbox.run under datum.submission").isEqualTo(submission.getSpanId());

        assertThat(submission.getTags()).containsEntry("channel", "http").containsEntry("outcome", "accepted")
            .containsEntry("form", TckFixtures.FORM);
        assertThat(run.getTags()).containsEntry("outcome", "ok").containsKey("engine.mode");
        assertThat(submission.getName()).isEqualTo("datum submission submit");
    }
}
