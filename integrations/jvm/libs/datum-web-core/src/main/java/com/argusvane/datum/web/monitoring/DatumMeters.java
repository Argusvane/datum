package com.argusvane.datum.web.monitoring;

import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import java.time.Duration;
import java.util.Objects;
import java.util.function.Supplier;

/**
 * Registers Datum's Micrometer meters ({@code datum.runs}, {@code datum.submissions}, {@code datum.throttled},
 * {@code datum.pdf.bytes}, ...) without the capabilities each touching the registry's API.
 *
 * <p>Framework-free (integrations/jvm/README.md "Libraries and bindings"): the
 * registry is passed in, nullable for "no metrics" ({@link #of}), or as a supplier asked on every use
 * ({@link #lazy}), which is how the Spring binding keeps reading it from the context whichever auto-configuration
 * creates it. A no-op while there is no registry. Tags are given as alternating key, value.
 */
public final class DatumMeters {

    private final Supplier<MeterRegistry> registry;

    private DatumMeters(Supplier<MeterRegistry> registry) {
        this.registry = registry;
    }

    /** Meters on {@code registry}, or none when it is null. */
    public static DatumMeters of(MeterRegistry registry) {
        return new DatumMeters(() -> registry);
    }

    /** Meters on whatever registry {@code registry} answers when a meter is recorded (null: none then). */
    public static DatumMeters lazy(Supplier<MeterRegistry> registry) {
        return new DatumMeters(Objects.requireNonNull(registry, "registry"));
    }

    /** No metrics. */
    public static DatumMeters none() {
        return of(null);
    }

    public void increment(String name, String... tags) {
        MeterRegistry meters = registry.get();
        if (meters != null) {
            meters.counter(name, tags).increment();
        }
    }

    public void record(String name, Duration elapsed, String... tags) {
        MeterRegistry meters = registry.get();
        if (meters != null) {
            Timer.builder(name).tags(tags).register(meters).record(elapsed);
        }
    }

    public void summary(String name, double amount, String... tags) {
        MeterRegistry meters = registry.get();
        if (meters != null) {
            meters.summary(name, tags).record(amount);
        }
    }

    /** A gauge read from {@code value} each time it is scraped; registered once per name and tags. */
    public void gauge(String name, Supplier<Number> value, String... tags) {
        MeterRegistry meters = registry.get();
        if (meters != null) {
            Gauge.builder(name, value).tags(tags).register(meters);
        }
    }
}
