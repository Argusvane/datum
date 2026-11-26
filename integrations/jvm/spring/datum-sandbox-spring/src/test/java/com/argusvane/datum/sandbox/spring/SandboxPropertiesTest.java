package com.argusvane.datum.sandbox.spring;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.core.DatumConfigurationException;
import com.argusvane.datum.sandbox.diagnostics.SettingsReport.Source;
import com.argusvane.datum.sandbox.protocol.ProgramLimits;
import com.argusvane.datum.sandbox.runtime.SandboxSettings;
import com.argusvane.datum.sandbox.wasi.EngineSettings;
import java.time.Duration;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.boot.context.properties.source.MapConfigurationPropertySource;
import org.springframework.util.unit.DataSize;

/**
 * The Spring properties map onto {@link SandboxSettings} with the same defaults, and what is clamped is the settings' doing, not
 * the binding's: the same bounds, the same texts, and the report says which key the binding moved.
 */
class SandboxPropertiesTest {

    @Test
    void thePropertiesDefaultsAreTheSettingsDefaults() {
        assertThat(new DatumSandboxProperties().toSettings()).isEqualTo(SandboxSettings.defaults());
        assertThat(new DatumSandboxProperties().toSettings(new DatumHostProperties())).isEqualTo(SandboxSettings.defaults());
        assertThat(new DatumSandboxProperties().toSettings().explain().entries()).allSatisfy(entry -> assertThat(entry.source()).isEqualTo(Source.DEFAULT));
    }

    @Test
    void theBytecodeAllowanceIsOffUnlessSetAndReachesTheSettings() {
        DatumSandboxProperties properties = new DatumSandboxProperties();
        assertThat(properties.isAllowBytecode()).isFalse();
        assertThat(properties.toSettings().engine().allowBytecode()).isFalse();
        properties.setAllowBytecode(true);
        assertThat(properties.toSettings().engine().allowBytecode()).isTrue();
        assertThat(properties.toSettings().explain().get("datum.runtime.allow-bytecode").source()).isEqualTo(Source.CONFIGURED);
    }

    @Test
    void theEngineKeysAreTheSettingsEngine() {
        DatumSandboxProperties properties = new DatumSandboxProperties();
        properties.setStopGrace(Duration.ofSeconds(9));
        properties.setMaxStrays(11);
        assertThat(properties.toSettings().engine().engineSettings()).isEqualTo(new EngineSettings(Duration.ofSeconds(9), 11));
        assertThat(new DatumSandboxProperties().toSettings().engine().engineSettings()).isEqualTo(EngineSettings.defaults());
        properties.setStopGrace(Duration.ofSeconds(-1));
        assertThatThrownBy(properties::toSettings).isInstanceOf(DatumConfigurationException.class).hasMessageContaining("datum.runtime.stop-grace");
        DatumSandboxProperties strays = new DatumSandboxProperties();
        strays.setMaxStrays(-2);
        assertThatThrownBy(strays::toSettings).isInstanceOf(DatumConfigurationException.class).hasMessageContaining("datum.runtime.max-strays");
    }

    @Test
    void limitsAndLifecycleAreClamped() {
        DatumSandboxProperties properties = new DatumSandboxProperties();
        properties.getValidation().setTimeLimit(Duration.ofMillis(2500));
        properties.getValidation().setMemory(DataSize.ofGigabytes(8));
        properties.getPdf().setConcurrency(500);
        properties.getPdf().setWait(Duration.ofSeconds(30));
        properties.setStartupBudget(Duration.ofHours(2));
        SandboxSettings settings = properties.toSettings();
        ProgramLimits limits = settings.limits(null);
        assertThat(limits.validationSeconds()).isEqualTo(2);
        assertThat(limits.validationMemory()).isEqualTo(ProgramLimits.VALIDATION_MEMORY.max());
        assertThat(limits.maxBodyBytes()).isEqualTo(ProgramLimits.BODY_BYTES.defaultValue());
        assertThat(settings.pdfSlots()).isEqualTo(64);
        assertThat(settings.pdf().slotWait()).isEqualTo(Duration.ofSeconds(10));
        assertThat(settings.lifecycle().startupBudget()).isEqualTo(Duration.ofMinutes(5));
        assertThat(new DatumSandboxProperties().toSettings().pdfSlots()).isEqualTo(Math.min(2, ProgramLimits.cpus()));
        assertThat(new DatumSandboxProperties().toSettings().pdf().slotWait()).isEqualTo(Duration.ofSeconds(2));
        assertThat(settings.explain().entries().stream().filter(entry -> entry.source() == Source.CLAMPED).map(entry -> entry.key()).toList())
            .containsExactlyInAnyOrder("datum.runtime.validation.time-limit", "datum.runtime.validation.memory", "datum.runtime.pdf.concurrency",
                "datum.runtime.pdf.wait", "datum.runtime.startup-budget");
    }

    @Test
    void aNegativeWarmUpOrGraceStopsTheStartNamingTheProperty() {
        DatumSandboxProperties warm = new DatumSandboxProperties();
        warm.setWarmUpRuns(-3);
        assertThatThrownBy(warm::toSettings).isInstanceOf(IllegalArgumentException.class).hasMessageContaining("datum.runtime.warm-up-runs");
        DatumSandboxProperties grace = new DatumSandboxProperties();
        grace.setShutdownGrace(Duration.ofSeconds(-10));
        assertThatThrownBy(grace::toSettings).isInstanceOf(IllegalArgumentException.class).hasMessageContaining("datum.runtime.shutdown-grace");
    }

    @Test
    void theHostWordsAreSetOnTheSettingsAndAWordTheProgramDoesNotReadStopsTheStart() {
        DatumHostProperties host = new DatumHostProperties();
        host.setFormulaErrors(DatumHostProperties.FormulaErrors.WARN);
        host.setRiskyPatterns(DatumHostProperties.RiskyPatterns.ALLOW);
        host.setTimeZone("America/Toronto");
        host.setUnknownFields(DatumHostProperties.UnknownFields.REJECT);
        host.setLogLevel(DatumHostProperties.LogLevel.DEBUG);
        assertThat(new DatumSandboxProperties().toSettings(host).host())
            .isEqualTo(new SandboxSettings.Host("warn", "allow", "America/Toronto", "reject", "debug"));
        DatumHostProperties zone = new DatumHostProperties();
        zone.setTimeZone("Not/AZone");
        assertThatThrownBy(() -> new DatumSandboxProperties().toSettings(zone)).hasMessageContaining("datum.host.time-zone");
        // Every word is an enum, bound relaxed as any Boot enum; Boot's own binding refuses one the program does not read.
        Binder binder = new Binder(new MapConfigurationPropertySource(Map.of("datum.host.formula-errors", "Warn", "datum.host.unknown-fields", "REJECT")));
        DatumHostProperties bound = binder.bind("datum.host", DatumHostProperties.class).get();
        assertThat(bound.getFormulaErrors()).isEqualTo(DatumHostProperties.FormulaErrors.WARN);
        assertThat(bound.getUnknownFields()).isEqualTo(DatumHostProperties.UnknownFields.REJECT);
        assertThatThrownBy(() -> new Binder(new MapConfigurationPropertySource(Map.of("datum.host.log-level", "loud")))
            .bind("datum.host", DatumHostProperties.class)).hasMessageContaining("datum.host");
    }

    @Test
    void theDiagnosticsKeysBindOntoTheSettingsAndAWordNoModeHasStopsTheStart() {
        Binder binder = new Binder(new MapConfigurationPropertySource(Map.of(
            "datum.runtime.diagnostics.trace", "Failures",
            "datum.runtime.diagnostics.report", "false",
            "datum.runtime.diagnostics.capture.enabled", "true",
            "datum.runtime.diagnostics.capture.directory", "/var/tmp/datum-captures",
            "datum.runtime.diagnostics.capture.max-runs", "5",
            "datum.runtime.diagnostics.capture.max-bytes", "1MB",
            "datum.runtime.diagnostics.capture.queue-bytes", "2MB")));
        DatumSandboxProperties bound = binder.bind("datum.runtime", DatumSandboxProperties.class).get();
        SandboxSettings settings = bound.toSettings();
        assertThat(settings.diagnostics()).isEqualTo(new SandboxSettings.Diagnostics(com.argusvane.datum.sandbox.diagnostics.TraceMode.FAILURES,
            new com.argusvane.datum.sandbox.diagnostics.CaptureSettings(true, java.nio.file.Path.of("/var/tmp/datum-captures"), 5,
                DataSize.ofMegabytes(1).toBytes(), DataSize.ofMegabytes(2).toBytes()), false));
        assertThat(settings.explain().get("datum.runtime.diagnostics.trace").source()).isEqualTo(Source.CONFIGURED);
        assertThat(settings.explain().get("datum.runtime.diagnostics.capture.directory").value()).isEqualTo("/var/tmp/datum-captures");

        DatumSandboxProperties defaults = new DatumSandboxProperties();
        assertThat(defaults.toSettings().diagnostics()).isEqualTo(SandboxSettings.Diagnostics.defaults());
        assertThatThrownBy(() -> new Binder(new MapConfigurationPropertySource(Map.of("datum.runtime.diagnostics.trace", "loud")))
            .bind("datum.runtime", DatumSandboxProperties.class)).hasMessageContaining("datum.runtime");
        DatumSandboxProperties none = new DatumSandboxProperties();
        none.getDiagnostics().getCapture().setMaxRuns(0);
        assertThatThrownBy(none::toSettings).isInstanceOf(DatumConfigurationException.class)
            .hasMessageContaining("datum.runtime.diagnostics.capture.max-runs");
    }

    /** The configuration metadata the IDE shows: datum.runtime.* and datum.host.* are this module's. */
    @Test
    void configurationMetadataIsGenerated() throws Exception {
        try (java.io.InputStream in = getClass().getClassLoader().getResourceAsStream("META-INF/spring-configuration-metadata.json")) {
            assertThat(in).isNotNull();
            String metadata = new String(in.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
            assertThat(metadata).contains("datum.runtime.fail-fast", "datum.runtime.allow-bytecode", "datum.runtime.validation.concurrency",
                "datum.runtime.stop-grace", "datum.runtime.max-strays", "datum.runtime.programs.sandbox",
                "datum.host.time-zone", "datum.host.unknown-fields",
                "datum.runtime.diagnostics.trace", "datum.runtime.diagnostics.report", "datum.runtime.diagnostics.capture.enabled",
                "datum.runtime.diagnostics.capture.directory", "datum.runtime.diagnostics.capture.max-runs",
                "datum.runtime.diagnostics.capture.max-bytes", "datum.runtime.diagnostics.capture.queue-bytes")
                .doesNotContain("datum.runtime.verify-max-bytes");
            // Each new key carries its description and, where it has one, its default, as the other keys do.
            assertThat(metadata).contains("Which runs get one trace line").contains("personal data").contains("\"defaultValue\": \"off\"");
        }
    }
}
