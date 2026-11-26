package com.argusvane.datum.sandbox.observation;

import com.argusvane.datum.sandbox.protocol.Program;
import com.argusvane.datum.sandbox.runtime.DatumSandbox;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import io.micrometer.core.instrument.binder.MeterBinder;
import java.time.Duration;
import java.util.Locale;

/**
 * The runtime's meters: {@code datum.runs} (a timer tagged {@code program} and
 * {@code outcome}), {@code datum.runs.wait} (how long a run sat before its thread started it),
 * {@code datum.runs.active} (runs in flight), {@code datum.runs.slots} (slots in use, tagged
 * {@code program}) and {@code datum.runs.rejected} (tagged {@code reason=busy}: runs refused because every slot stayed
 * taken). The submissions counters are {@link SubmissionMetrics}.
 *
 * <p>The busy count is told by the slots themselves (a hook in datum-core's {@code RunSlots}), so it is true for every caller: the HTTP routes, a queue consumer, a
 * batch import and the definition service alike. Counting in an error translator would see only the
 * refusals that reached the HTTP error mapper.
 *
 * <p>Spring Boot binds every {@link MeterBinder} bean to its registries; binding also installs this as the
 * runtime's run watcher. Outcomes are the termination ({@code exited}, {@code budget}, {@code trap},
 * {@code output_cap}, {@code interrupted}, {@code stuck}: a run past its budget and the backstop whose thread would not
 * end, ...) or the failure's reason: a fixed small set, so the tags stay
 * bounded. The slot wait before the runtime is entered belongs to the caller's slot and is not part of
 * {@code datum.runs.wait}.
 */
public final class SandboxRunMetrics implements MeterBinder, DatumSandbox.RunObserver {

    private final DatumSandbox runtime;
    private volatile MeterRegistry registry;

    public SandboxRunMetrics(DatumSandbox runtime) {
        this.runtime = runtime;
    }

    @Override
    public void bindTo(MeterRegistry meters) {
        this.registry = meters;
        Gauge.builder("datum.runs.active", () -> runtime.status().inFlight())
            .description("Program runs in flight now").register(meters);
        Gauge.builder("datum.runs.slots", () -> runtime.status().validationSlots() - runtime.status().validationSlotsFree())
            .tag("program", "sandbox").description("Slots in use").register(meters);
        Gauge.builder("datum.runs.slots", () -> runtime.status().pdfSlots() - runtime.status().pdfSlotsFree())
            .tag("program", "pdf").description("Slots in use").register(meters);
        runtime.observer(this);
    }

    @Override
    public void ran(Program.Kind kind, String outcome, Duration elapsed) {
        MeterRegistry meters = registry;
        if (meters != null) {
            Timer.builder("datum.runs").description("Program runs").tag("program", program(kind)).tag("outcome", outcome)
                .register(meters).record(elapsed);
        }
    }

    @Override
    public void refused(Program.Kind kind) {
        MeterRegistry meters = registry;
        if (meters != null) {
            meters.counter("datum.runs.rejected", "reason", "busy").increment();
        }
    }

    @Override
    public void started(Program.Kind kind, Duration waited) {
        MeterRegistry meters = registry;
        if (meters != null) {
            Timer.builder("datum.runs.wait").description("Thread hand-off time only (accepted to started); the slot wait is not included")
                .tag("program", program(kind)).register(meters).record(waited);
        }
    }

    static String program(Program.Kind kind) {
        return kind.name().toLowerCase(Locale.ROOT);
    }
}
