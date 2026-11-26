package com.argusvane.datum.core.observation;

import io.micrometer.common.KeyValue;
import io.micrometer.observation.Observation;
import io.micrometer.observation.ObservationHandler;
import io.micrometer.observation.ObservationRegistry;
import io.micrometer.observation.ObservationView;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * A real {@link ObservationRegistry} whose one handler records every observation as it stops, with its keys, its error and
 * the name of its parent: what a tracer would make a span of, so a test can tell which observation encloses
 * which. In datum-core-test-support (never published), for every library's observation tests.
 */
public final class RecordingObservations {

    /** One stopped observation. */
    public record Recorded(String name, String contextualName, Map<String, String> low, Map<String, String> high, Throwable error,
                           String parent, String thread) {

        public String low(String key) {
            return low.get(key);
        }
    }

    private final ObservationRegistry registry = ObservationRegistry.create();
    private final List<Recorded> stopped = Collections.synchronizedList(new ArrayList<>());

    public RecordingObservations() {
        registry.observationConfig().observationHandler(new ObservationHandler<>() {
            @Override
            public boolean supportsContext(Observation.Context context) {
                return true;
            }

            @Override
            public void onStop(Observation.Context context) {
                Map<String, String> low = new LinkedHashMap<>();
                for (KeyValue value : context.getLowCardinalityKeyValues()) {
                    low.put(value.getKey(), value.getValue());
                }
                Map<String, String> high = new LinkedHashMap<>();
                for (KeyValue value : context.getHighCardinalityKeyValues()) {
                    high.put(value.getKey(), value.getValue());
                }
                ObservationView parent = context.getParentObservation();
                stopped.add(new Recorded(context.getName(), context.getContextualName(), low, high, context.getError(),
                    parent == null ? null : parent.getContextView().getName(), Thread.currentThread().getName()));
            }
        });
    }

    /** The registry the observations go to. */
    public ObservationRegistry registry() {
        return registry;
    }

    /** Datum's observations on this registry. */
    public DatumObservations observations() {
        return MicrometerObservations.of(registry);
    }

    /** Every observation stopped so far, in the order they stopped. */
    public List<Recorded> stopped() {
        synchronized (stopped) {
            return List.copyOf(stopped);
        }
    }

    /** The stopped observations of one name. */
    public List<Recorded> named(String name) {
        return stopped().stream().filter(one -> one.name().equals(name)).toList();
    }

    public void clear() {
        stopped.clear();
    }
}
