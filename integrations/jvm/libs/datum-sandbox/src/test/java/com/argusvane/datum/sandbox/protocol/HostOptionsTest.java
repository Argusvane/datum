package com.argusvane.datum.sandbox.protocol;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

/** The context keys the host decides and the inspect op's formula policy. */
class HostOptionsTest {

    private static final Clock CLOCK = Clock.fixed(Instant.parse("2026-10-15T23:30:00Z"), ZoneOffset.UTC);

    @Test
    void defaultsAreFailRefuse() {
        HostOptions options = new HostOptions(null, null, "UTC", CLOCK);
        assertThat(options.formulaErrors()).isEqualTo("fail");
        assertThat(options.riskyPatterns()).isEqualTo("refuse");
        assertThat(options.today()).isEqualTo("2026-10-15");
        assertThat(options.contextKeys()).containsExactly(
            java.util.Map.entry("today", "2026-10-15"), java.util.Map.entry("formulaErrors", "fail"), java.util.Map.entry("riskyPatterns", "refuse"));
    }

    @Test
    void policiesAreNormalised() {
        assertThat(new HostOptions("warn", "allow", "UTC", CLOCK).formulaErrors()).isEqualTo("warn");
        assertThat(new HostOptions(null, "allow", "UTC", CLOCK).riskyPatterns()).isEqualTo("allow");
        assertThat(HostOptions.policy("warn")).isEqualTo("warn");
        assertThat(HostOptions.policy("fail")).isEqualTo("fail");
        assertThat(HostOptions.policy("anything")).isEqualTo("fail");
        assertThat(HostOptions.policy(null)).isEqualTo("fail");
    }

    /**
     * A word the program does not read is refused, naming the property and the allowed words, on every path
     * (it was read as the default, so an application's own options bean with a typo ran a policy it never chose).
     */
    @Test
    void anUnknownPolicyWordIsRefusedNotReadAsTheDefault() {
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> new HostOptions("WARN", null, "UTC", CLOCK))
            .isInstanceOfSatisfying(com.argusvane.datum.core.DatumConfigurationException.class, refusal -> {
                assertThat(refusal.property()).isEqualTo("datum.host.formula-errors");
                assertThat(refusal.getMessage()).contains("'WARN'").contains("[warn, fail]");
                assertThat(refusal.action()).contains("datum.host.formula-errors");
            });
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> new HostOptions(null, "warn", "UTC", CLOCK))
            .isInstanceOf(com.argusvane.datum.core.DatumConfigurationException.class).hasMessageContaining("datum.host.risky-patterns");
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> new HostOptions("", null, "UTC", CLOCK))
            .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void theTypedConstructorTakesNullAsTheDefaultAndKeepsTheWireWords() {
        HostOptions typed = HostOptions.of(HostOptions.FormulaErrors.WARN, HostOptions.RiskyPatterns.ALLOW, "UTC", CLOCK);
        assertThat(typed.formulaErrors()).isEqualTo("warn");
        assertThat(typed.riskyPatterns()).isEqualTo("allow");
        HostOptions defaults = HostOptions.of(null, null, "UTC", CLOCK);
        assertThat(defaults.formulaErrors()).isEqualTo("fail");
        assertThat(defaults.riskyPatterns()).isEqualTo("refuse");
    }

    /** Today in the host's zone; a zone id that does not exist is refused, as the configuration refuses it. */
    @Test
    void todayIsInTheHostsTimeZone() {
        assertThat(new HostOptions(null, null, "Pacific/Auckland", CLOCK).today()).isEqualTo("2026-10-16");
        assertThat(new HostOptions(null, null, "America/Toronto", CLOCK).today()).isEqualTo("2026-10-15");
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> new HostOptions(null, null, "Not/AZone", CLOCK))
            .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("Not/AZone");
    }

    @Test
    void mergeOverwritesAndAddMissingKeepsTheCallers() {
        HostOptions options = new HostOptions("warn", "allow", "UTC", CLOCK);
        ObjectNode context = JsonNodeFactory.instance.objectNode();
        context.put("formulaErrors", "fail").put("today", "1999-01-01").put("riskyPatterns", "allow");
        options.mergeInto(context);
        assertThat(context.get("formulaErrors").stringValue()).isEqualTo("warn");
        assertThat(context.get("today").stringValue()).isEqualTo("2026-10-15");
        ObjectNode request = JsonNodeFactory.instance.objectNode();
        request.put("today", "2026-01-02");
        request.putNull("riskyPatterns");
        options.addMissing(request);
        assertThat(request.get("today").stringValue()).isEqualTo("2026-01-02");
        assertThat(request.get("riskyPatterns").stringValue()).isEqualTo("allow");
        assertThat(request.get("formulaErrors").stringValue()).isEqualTo("warn");
    }
}
