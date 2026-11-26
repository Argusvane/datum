package com.argusvane.datum.pdf.spring;

import io.micrometer.observation.Observation;
import io.micrometer.observation.ObservationRegistry;
import java.util.Map;
import org.slf4j.MDC;
import org.springframework.core.task.TaskDecorator;

/**
 * Carries the caller's context to the thread the TSA call runs on: the SLF4J
 * MDC (a request id, the trace ids a tracer put there) and the observation current on the caller's thread, whose scope is
 * opened around the call, so Spring's {@code http.client.requests} observation of the call (RestClient's) is a child of the
 * seal or receipt that asked, under the HTTP request's trace, rather than the root of a trace of its own. Captured when the
 * call is handed to the executor ({@link #decorate}, on the caller's thread), restored on the worker, and the worker's own
 * MDC put back after.
 *
 * <p>Datum's own rather than Spring's {@code ContextPropagatingTaskDecorator}, which needs the context-propagation library an
 * application may not have; an application's own {@code TaskDecorator} beans still run, composed around this one.
 */
final class TsaCallContext implements TaskDecorator {

    private final ObservationRegistry registry;

    /** @param registry the application's registry, or null when it has none (only the MDC is carried then) */
    TsaCallContext(ObservationRegistry registry) {
        this.registry = registry;
    }

    @Override
    public Runnable decorate(Runnable runnable) {
        Map<String, String> callers = MDC.getCopyOfContextMap();
        Observation current = registry == null ? null : registry.getCurrentObservation();
        return () -> {
            Map<String, String> own = MDC.getCopyOfContextMap();
            if (callers == null) {
                MDC.clear();
            } else {
                MDC.setContextMap(callers);
            }
            try {
                if (current == null) {
                    runnable.run();
                } else {
                    try (Observation.Scope ignored = current.openScope()) {
                        runnable.run();
                    }
                }
            } finally {
                if (own == null) {
                    MDC.clear();
                } else {
                    MDC.setContextMap(own);
                }
            }
        };
    }
}
