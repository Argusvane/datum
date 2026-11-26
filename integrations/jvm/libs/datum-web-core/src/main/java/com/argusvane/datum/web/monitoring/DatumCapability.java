package com.argusvane.datum.web.monitoring;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.function.Supplier;

/**
 * One module's contribution to {@link DatumCapabilities}: that the capability is present, what it adds to
 * {@code info.datum}, and where its endpoints live for {@code host.json}. A binding declares it as a bean of its own (in
 * Spring, collected with {@code orderedStream()}), so a facade or a runtime the application replaces carries no
 * registration and the start-up notice, {@code info} and {@code host.json} stay true. Two contributions may name one
 * capability (the submissions module's runtime details and its idempotency store's); a detail key or an endpoint name is
 * contributed once.
 *
 * @param name the capability's catalog name ({@code forms}, {@code submissions}, {@code ui}, {@code pdf}, {@code timestamp},
 *     {@code webauthn})
 * @param details what it adds to {@code info.datum}, by key, each evaluated when read (a null value is left out)
 * @param endpoints the application-relative base path of its endpoints, by name ({@code webauthn}, {@code tsa})
 */
public record DatumCapability(String name, Map<String, Supplier<?>> details, Map<String, String> endpoints) {

    public DatumCapability {
        Objects.requireNonNull(name, "name");
        if (name.isBlank()) {
            throw new IllegalArgumentException("A Datum capability needs a name.");
        }
        details = Map.copyOf(details);
        endpoints = Map.copyOf(endpoints);
    }

    /** The capability, present, with nothing to add. */
    public static DatumCapability of(String name) {
        return new DatumCapability(name, Map.of(), Map.of());
    }

    /** This contribution with {@code key} in {@code info.datum}, evaluated when read. */
    public DatumCapability withDetail(String key, Supplier<?> value) {
        Map<String, Supplier<?>> more = new LinkedHashMap<>(details);
        more.put(Objects.requireNonNull(key, "key"), Objects.requireNonNull(value, "value"));
        return new DatumCapability(name, more, endpoints);
    }

    /** This contribution with an endpoint base for {@code host.json}'s {@code paths}. */
    public DatumCapability withEndpoint(String endpoint, String path) {
        Map<String, String> more = new LinkedHashMap<>(endpoints);
        more.put(Objects.requireNonNull(endpoint, "endpoint"), Objects.requireNonNull(path, "path"));
        return new DatumCapability(name, details, more);
    }
}
