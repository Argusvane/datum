package com.argusvane.datum.springweb.spring;

import com.argusvane.datum.web.monitoring.DatumHealthContributors;
import java.util.Objects;
import java.util.stream.Stream;
import org.springframework.boot.health.contributor.CompositeHealthContributor;
import org.springframework.boot.health.contributor.Health;
import org.springframework.boot.health.contributor.HealthContributor;
import org.springframework.boot.health.contributor.HealthIndicator;

/**
 * The {@code datum} health contributor: a composite with one member per {@code DatumHealthCheck} bean
 * ({@code datum/runtime}, {@code datum/pdf}, {@code datum/datum-tsa}, {@code datum/datum-webauthn}), so a health group
 * can include one of them (a TSA or passkey-store problem then stays visible without taking the instance out of
 * readiness) and Boot's aggregation folds them. Each member is UP or DOWN with the check's details; a check that throws is
 * DOWN with its exception's class name (the library's rule). The members are read from the checks when asked, so the
 * composite never holds a stale list.
 */
public final class DatumHealthContributor implements CompositeHealthContributor {

    private final DatumHealthContributors checks;

    public DatumHealthContributor(DatumHealthContributors checks) {
        this.checks = Objects.requireNonNull(checks, "checks");
    }

    @Override
    public HealthContributor getContributor(String name) {
        return checks.names().contains(name) ? member(name) : null;
    }

    @Override
    public Stream<Entry> stream() {
        return checks.names().stream().map(name -> new Entry(name, member(name)));
    }

    private HealthIndicator member(String name) {
        return () -> {
            DatumHealthContributors.Status status = checks.evaluate(name);
            return (status.up() ? Health.up() : Health.down()).withDetails(status.details()).build();
        };
    }
}
