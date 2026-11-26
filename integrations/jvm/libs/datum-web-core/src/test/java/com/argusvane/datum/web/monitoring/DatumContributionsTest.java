package com.argusvane.datum.web.monitoring;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatIllegalArgumentException;
import static org.assertj.core.api.Assertions.assertThatIllegalStateException;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

/**
 * Capabilities and health checks as contributions the registries collect: each module declares a
 * {@link DatumCapability} or a {@link DatumHealthCheck} of its own, so replacing a facade or the runtime no longer drops
 * a registration that lived inside its factory method.
 */
class DatumContributionsTest {

    @Test
    void theCapabilitiesAreTheContributionsMerged() {
        DatumCapabilities capabilities = DatumCapabilities.of(
            DatumCapability.of("submissions").withDetail("engine", () -> "endive").withDetail("nativeProvider", () -> null),
            DatumCapability.of("forms"),
            DatumCapability.of("submissions").withDetail("idempotency", () -> "memory"),
            DatumCapability.of("webauthn").withEndpoint("webauthn", "/api/webauthn"));

        assertThat(capabilities.present()).containsExactly("forms", "submissions", "webauthn");
        assertThat(capabilities.details()).as("a null detail is left out").containsExactly(Map.entry("engine", "endive"),
            Map.entry("idempotency", "memory"));
        assertThat(capabilities.endpoints()).containsExactly(Map.entry("webauthn", "/api/webauthn"));
    }

    @Test
    void detailsAreEvaluatedWhenReadAndTheContributionsCollectedOnce() {
        AtomicInteger asked = new AtomicInteger();
        AtomicInteger collected = new AtomicInteger();
        List<String> value = new ArrayList<>(List.of("first"));
        DatumCapabilities capabilities = new DatumCapabilities(() -> {
            collected.incrementAndGet();
            return List.of(DatumCapability.of("ui").withDetail("builder", () -> {
                asked.incrementAndGet();
                return value.get(0);
            }));
        });
        assertThat(collected).as("nothing is collected before the first read").hasValue(0);
        assertThat(capabilities.details()).containsEntry("builder", "first");
        value.set(0, "second");
        assertThat(capabilities.details()).containsEntry("builder", "second");
        assertThat(asked).hasValue(2);
        assertThat(collected).hasValue(1);
    }

    @Test
    void twoContributionsOfOneDetailOrEndpointAreRefused() {
        assertThatIllegalStateException().isThrownBy(() -> DatumCapabilities.of(DatumCapability.of("pdf").withDetail("timestamp", () -> "site"),
            DatumCapability.of("timestamp").withDetail("timestamp", () -> "none")).details()).withMessageContaining("timestamp");
        assertThatIllegalStateException().isThrownBy(() -> DatumCapabilities.of(DatumCapability.of("timestamp").withEndpoint("tsa", "/tsa"),
            DatumCapability.of("other").withEndpoint("tsa", "/elsewhere")).endpoints()).withMessageContaining("tsa");
    }

    @Test
    void aCapabilityHasAName() {
        assertThatIllegalArgumentException().isThrownBy(() -> DatumCapability.of(" "));
        assertThatIllegalArgumentException().isThrownBy(() -> DatumHealthCheck.of("", () -> DatumHealthContributors.Status.up(Map.of())));
    }

    @Test
    void theHealthChecksAreTheContributionsByName() {
        DatumHealthContributors health = DatumHealthContributors.of(
            DatumHealthCheck.of("timestamp", () -> DatumHealthContributors.Status.down("no key")),
            DatumHealthCheck.of("runtime", () -> DatumHealthContributors.Status.up(Map.of("slots", 2))),
            DatumHealthCheck.of("webauthn", () -> {
                throw new IllegalStateException("store gone");
            }));

        assertThat(health.isEmpty()).isFalse();
        assertThat(health.names()).containsExactly("runtime", "timestamp", "webauthn");
        Map<String, DatumHealthContributors.Status> checks = health.evaluate();
        assertThat(checks.keySet()).containsExactly("runtime", "timestamp", "webauthn");
        assertThat(checks.get("runtime").up()).isTrue();
        assertThat(checks.get("timestamp").details()).containsEntry("reason", "no key");
        assertThat(checks.get("webauthn").details()).as("a check that throws is DOWN with its exception's class name")
            .containsEntry("reason", "IllegalStateException");
        assertThat(health.evaluate("runtime").details()).containsEntry("slots", 2);
        assertThat(DatumHealthContributors.of().isEmpty()).isTrue();
    }

    @Test
    void twoChecksOfOneNameAreRefused() {
        assertThatIllegalStateException().isThrownBy(() -> DatumHealthContributors.of(
            DatumHealthCheck.of("runtime", () -> DatumHealthContributors.Status.up(Map.of())),
            DatumHealthCheck.of("runtime", () -> DatumHealthContributors.Status.down("again"))).evaluate()).withMessageContaining("runtime");
    }
}
