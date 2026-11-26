package com.argusvane.datum.web.monitoring;

import java.util.Objects;
import java.util.function.Supplier;

/**
 * One module's health check, contributed to {@link DatumHealthContributors}: a bean of its own (in Spring,
 * collected with {@code orderedStream()}), so an application that replaces the runtime or a facade keeps the check. With
 * actuator, each check is one member of the {@code datum} composite ({@code datum/runtime}, {@code datum/datum-tsa}, ...),
 * so a health group can include one of them.
 *
 * @param name the check's name, unique among the checks
 * @param check the state now; quick, and a check that throws is DOWN with its exception's class name
 */
public record DatumHealthCheck(String name, Supplier<DatumHealthContributors.Status> check) {

    public DatumHealthCheck {
        Objects.requireNonNull(name, "name");
        Objects.requireNonNull(check, "check");
        if (name.isBlank()) {
            throw new IllegalArgumentException("A Datum health check needs a name.");
        }
    }

    public static DatumHealthCheck of(String name, Supplier<DatumHealthContributors.Status> check) {
        return new DatumHealthCheck(name, check);
    }
}
