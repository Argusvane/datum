package com.argusvane.datum.core.observation;

import io.micrometer.observation.Observation;
import io.micrometer.observation.ObservationRegistry;
import java.util.Objects;

/**
 * {@link DatumObservations} on Micrometer's Observation API: each Datum observation is an
 * {@link Observation} on the host's {@link ObservationRegistry}, started with its scope open, so it is a child of the
 * observation current on the thread (the HTTP request's, under Spring MVC) and the parent of what it encloses. The
 * registry's handlers make of it what the host configured (a span, a timer, a log line); its predicates switch it off by
 * name. The only Datum class besides {@link DatumObservationDocumentation} that names Micrometer: a host without
 * {@code micrometer-observation} never loads it.
 */
public final class MicrometerObservations implements DatumObservations {

    private final ObservationRegistry registry;

    private MicrometerObservations(ObservationRegistry registry) {
        this.registry = Objects.requireNonNull(registry, "registry");
    }

    /**
     * Over {@code registry}; Micrometer's {@link ObservationRegistry#NOOP} is {@link DatumObservations#none()}, so nothing is
     * wrapped for it. Any other registry is taken as it is, even one with no handler yet: a host registers its handlers when
     * it pleases (Spring Boot while the registry bean is made, a test after), and each observation asks the registry then, so
     * one started while it has none is a no-op.
     */
    public static DatumObservations of(ObservationRegistry registry) {
        Objects.requireNonNull(registry, "registry");
        return registry == ObservationRegistry.NOOP ? DatumObservations.none() : new MicrometerObservations(registry);
    }

    /** The registry the observations go to. */
    public ObservationRegistry registry() {
        return registry;
    }

    @Override
    public DatumObservation start(String name, String contextualName, String... lowCardinality) {
        if (lowCardinality.length % 2 != 0) {
            throw new IllegalArgumentException("Low-cardinality keys come in key, value pairs.");
        }
        Observation observation = Observation.createNotStarted(name, registry).contextualName(contextualName);
        if (observation.isNoop()) {
            // The registry's predicate turned this name off (management.observations.enable.datum...=false).
            return NoObservations.INSTANCE;
        }
        for (int i = 0; i < lowCardinality.length; i += 2) {
            observation.lowCardinalityKeyValue(lowCardinality[i], lowCardinality[i + 1]);
        }
        observation.start();
        return new Started(observation, observation.openScope());
    }

    /** One started observation and its scope, closed and stopped once. */
    private static final class Started implements DatumObservation {

        private final Observation observation;
        private final Observation.Scope scope;
        private boolean closed;

        Started(Observation observation, Observation.Scope scope) {
            this.observation = observation;
            this.scope = scope;
        }

        @Override
        public DatumObservation lowCardinality(String key, String value) {
            observation.lowCardinalityKeyValue(key, value == null ? DatumObservationNames.NONE : value);
            return this;
        }

        @Override
        public DatumObservation highCardinality(String key, String value) {
            if (value != null) {
                observation.highCardinalityKeyValue(key, value);
            }
            return this;
        }

        @Override
        public DatumObservation error(Throwable failure) {
            if (failure != null) {
                observation.error(failure);
            }
            return this;
        }

        @Override
        public void close() {
            if (closed) {
                return;
            }
            closed = true;
            try {
                scope.close();
            } finally {
                observation.stop();
            }
        }
    }
}
