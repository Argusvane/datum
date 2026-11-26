package com.argusvane.datum.web.monitoring;

import java.util.Collection;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeMap;
import java.util.function.Supplier;

/**
 * The health checks the capabilities contribute ({@link DatumHealthCheck}), by name: the runtime (UP after
 * the ABI probe and a cached smoke run; DOWN names the reason; slots in use), the PDF program, the timestamp server and
 * passkeys. With actuator the binding shows each as one member of the {@code datum} composite. No actuator class is named
 * here.
 *
 * <p>The checks are collected on the first read (the binding passes its bean collection), and two checks of one name stop
 * that read with an {@link IllegalStateException}.
 */
public final class DatumHealthContributors {

    /**
     * One check's state.
     *
     * @param up      whether it is healthy
     * @param details what to show (a reason when down, the slots in use)
     */
    public record Status(boolean up, Map<String, Object> details) {

        public Status {
            details = details == null ? Map.of() : Map.copyOf(details);
        }

        public static Status up(Map<String, Object> details) {
            return new Status(true, details);
        }

        public static Status down(String reason) {
            return new Status(false, Map.of("reason", reason));
        }
    }

    private final Supplier<? extends Collection<DatumHealthCheck>> contributions;
    private volatile Map<String, DatumHealthCheck> checks;

    /** @param contributions the checks, asked once on the first read */
    public DatumHealthContributors(Supplier<? extends Collection<DatumHealthCheck>> contributions) {
        this.contributions = Objects.requireNonNull(contributions, "contributions");
    }

    /** These checks (tests, and a host without a container). */
    public static DatumHealthContributors of(DatumHealthCheck... checks) {
        List<DatumHealthCheck> fixed = List.of(checks);
        return new DatumHealthContributors(() -> fixed);
    }

    private Map<String, DatumHealthCheck> checks() {
        Map<String, DatumHealthCheck> current = checks;
        if (current == null) {
            synchronized (this) {
                current = checks;
                if (current == null) {
                    Map<String, DatumHealthCheck> byName = new TreeMap<>();
                    for (DatumHealthCheck check : contributions.get()) {
                        if (byName.putIfAbsent(check.name(), check) != null) {
                            throw new IllegalStateException("Two Datum health checks are named '" + check.name() + "': a name has one check.");
                        }
                    }
                    current = Collections.unmodifiableMap(byName);
                    checks = current;
                }
            }
        }
        return current;
    }

    /** The checks' names, sorted. */
    public Set<String> names() {
        return checks().keySet();
    }

    /** One check's state now; a check that throws is DOWN with its exception's class name. */
    public Status evaluate(String name) {
        DatumHealthCheck check = checks().get(name);
        if (check == null) {
            throw new IllegalArgumentException("No Datum health check is named '" + name + "'.");
        }
        try {
            Status status = check.check().get();
            return status == null ? Status.down("no status") : status;
        } catch (RuntimeException e) {
            return Status.down(e.getClass().getSimpleName());
        }
    }

    /** Evaluates every check, sorted by name; a check that throws is DOWN with its exception's class name. */
    public Map<String, Status> evaluate() {
        Map<String, Status> out = new LinkedHashMap<>();
        for (String name : names()) {
            out.put(name, evaluate(name));
        }
        return out;
    }

    public boolean isEmpty() {
        return checks().isEmpty();
    }
}
