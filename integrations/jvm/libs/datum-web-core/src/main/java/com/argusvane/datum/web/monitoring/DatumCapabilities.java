package com.argusvane.datum.web.monitoring;

import java.util.Collection;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.function.Supplier;

/**
 * Which capabilities are present and what each adds to {@code info.datum}: the {@link DatumCapability} contributions,
 * merged (each capability contributes through its own bean, never as a side effect inside another bean's factory method,
 * so replacing one bean never drops a registration).
 *
 * <p>The contributions are collected on the first read (the binding passes its bean collection, read once every bean
 * exists: the start-up notice, {@code host.json}, {@code info}), and the details are evaluated on every read. A detail key
 * or an endpoint name that two contributions name stops that first read with an {@link IllegalStateException}. No
 * actuator class is named here, so this costs nothing without actuator.
 */
public final class DatumCapabilities {

    private final Supplier<? extends Collection<DatumCapability>> contributions;
    private volatile Merged merged;

    /** @param contributions the contributions, asked once on the first read */
    public DatumCapabilities(Supplier<? extends Collection<DatumCapability>> contributions) {
        this.contributions = Objects.requireNonNull(contributions, "contributions");
    }

    /** These contributions (tests, and a host without a container). */
    public static DatumCapabilities of(DatumCapability... contributions) {
        List<DatumCapability> fixed = List.of(contributions);
        return new DatumCapabilities(() -> fixed);
    }

    private record Merged(Set<String> present, Map<String, Supplier<?>> details, Map<String, String> endpoints) {
    }

    private Merged merged() {
        Merged current = merged;
        if (current == null) {
            synchronized (this) {
                current = merged;
                if (current == null) {
                    current = merge(contributions.get());
                    merged = current;
                }
            }
        }
        return current;
    }

    private static Merged merge(Collection<DatumCapability> all) {
        Set<String> present = new TreeSet<>();
        Map<String, Supplier<?>> details = new TreeMap<>();
        Map<String, String> endpoints = new TreeMap<>();
        Map<String, String> detailOwner = new LinkedHashMap<>();
        Map<String, String> endpointOwner = new LinkedHashMap<>();
        for (DatumCapability capability : all) {
            present.add(capability.name());
            capability.details().forEach((key, value) -> {
                String before = detailOwner.putIfAbsent(key, capability.name());
                if (before != null) {
                    throw new IllegalStateException("Two Datum capability contributions (" + before + ", " + capability.name()
                        + ") name the info.datum detail '" + key + "': one detail has one contributor.");
                }
                details.put(key, value);
            });
            capability.endpoints().forEach((name, path) -> {
                String before = endpointOwner.putIfAbsent(name, capability.name());
                if (before != null) {
                    throw new IllegalStateException("Two Datum capability contributions (" + before + ", " + capability.name()
                        + ") name the endpoint base '" + name + "': one base has one contributor.");
                }
                endpoints.put(name, path);
            });
        }
        return new Merged(Collections.unmodifiableSet(present), Collections.unmodifiableMap(details), Collections.unmodifiableMap(endpoints));
    }

    /**
     * Where a capability's endpoints live, for {@code host.json}'s {@code paths} (so the glue stops guessing a path the
     * application moved): {@code webauthn} and {@code tsa}. Application-relative, as configured ({@code /api/webauthn});
     * {@code host.json} adds the context path. Sorted by name.
     */
    public Map<String, String> endpoints() {
        return merged().endpoints();
    }

    /** The capabilities present, sorted. */
    public Set<String> present() {
        return merged().present();
    }

    /** The extra details, evaluated now, sorted by key; a null value is left out. */
    public Map<String, Object> details() {
        Map<String, Object> out = new LinkedHashMap<>();
        merged().details().forEach((key, value) -> {
            Object now = value.get();
            if (now != null) {
                out.put(key, now);
            }
        });
        return out;
    }
}
