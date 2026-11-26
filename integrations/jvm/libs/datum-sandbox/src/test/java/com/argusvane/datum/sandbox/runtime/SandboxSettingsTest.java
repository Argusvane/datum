package com.argusvane.datum.sandbox.runtime;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.core.DatumConfigurationException;
import com.argusvane.datum.core.io.ResourceHandle;
import com.argusvane.datum.sandbox.diagnostics.SettingsReport;
import com.argusvane.datum.sandbox.diagnostics.SettingsReport.Entry;
import com.argusvane.datum.sandbox.diagnostics.SettingsReport.Source;
import com.argusvane.datum.sandbox.protocol.ProgramLimits;
import com.argusvane.datum.sandbox.wasi.EngineSettings;
import java.nio.file.Path;
import java.time.Duration;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;
import org.junit.jupiter.api.Test;

/**
 * The one settings tree: every default, every clamp and every refusal is here, and the report says
 * for each key whether the value in force is the default, was configured, or was clamped, in the WARN texts a clamp logs. Nothing in a framework binding decides a bound; these tests are the bounds.
 */
class SandboxSettingsTest {

    private static final String RT = "datum.runtime.";

    /** What one build logged, and the settings it made. */
    private record Built(SandboxSettings settings, List<String> warnings) {

        Entry entry(String key) {
            Entry entry = settings.explain().get(key);
            assertThat(entry).as("an entry for " + key).isNotNull();
            return entry;
        }
    }

    private static Built build(Consumer<SandboxSettings.Builder> set) {
        List<String> warnings = new ArrayList<>();
        SandboxSettings.Builder builder = SandboxSettings.builder().warnings(warnings::add);
        set.accept(builder);
        return new Built(builder.build(), warnings);
    }

    // ---------------------------------------------------------------------------------------------- DEFAULT

    @Test
    void nothingSetIsTheDefaultsAndEveryKeyIsReportedAsDefault() {
        Built built = build(b -> { });
        SandboxSettings s = built.settings();
        assertThat(s).isEqualTo(SandboxSettings.defaults());
        assertThat(built.warnings()).isEmpty();
        assertThat(s.engine().id()).isEqualTo("endive");
        assertThat(s.engine().allowBytecode()).isFalse();
        assertThat(s.engine().stopGrace()).isEqualTo(EngineSettings.DEFAULT_STOP_GRACE);
        assertThat(s.engine().maxStrays()).isEqualTo(EngineSettings.defaultMaxStrays());
        assertThat(s.lifecycle().failFast()).isTrue();
        assertThat(s.lifecycle().warmUpRuns()).isEqualTo(3);
        assertThat(s.lifecycle().startupBudget()).isEqualTo(Duration.ofSeconds(30));
        assertThat(s.lifecycle().shutdownGrace()).isEqualTo(Duration.ofSeconds(10));
        assertThat(s.validation()).isEqualTo(new SandboxSettings.Run(Duration.ofSeconds(5), 32 * ProgramLimits.MIB, 0, Duration.ofSeconds(2)));
        assertThat(s.pdf()).isEqualTo(new SandboxSettings.Run(Duration.ofSeconds(15), 256 * ProgramLimits.MIB, 0, Duration.ofSeconds(2)));
        assertThat(s.programs()).isEqualTo(new SandboxSettings.Programs(null, null));
        assertThat(s.host()).isEqualTo(new SandboxSettings.Host("fail", "refuse", null, "strip", "warn"));
        assertThat(s.diagnostics()).isEqualTo(SandboxSettings.Diagnostics.defaults());
        assertThat(s.explain().entries()).isNotEmpty().allSatisfy(entry -> assertThat(entry.source()).as(entry.key()).isEqualTo(Source.DEFAULT));
        assertThat(s.explain().warnings()).isEmpty();
        assertThat(s.limits(null)).isEqualTo(ProgramLimits.defaults());
    }

    @Test
    void theReportNamesEveryPropertyKeyOnceInTheDocumentedOrder() {
        List<String> keys = SandboxSettings.defaults().explain().entries().stream().map(Entry::key).toList();
        assertThat(keys).containsExactly(
            RT + "engine", RT + "allow-bytecode", RT + "stop-grace", RT + "max-strays",
            RT + "fail-fast", RT + "warm-up-runs", RT + "startup-budget", RT + "shutdown-grace",
            RT + "validation.time-limit", RT + "validation.memory", RT + "validation.concurrency", RT + "validation.wait",
            RT + "pdf.time-limit", RT + "pdf.memory", RT + "pdf.concurrency", RT + "pdf.wait",
            RT + "programs.sandbox", RT + "programs.pdf",
            "datum.host.formula-errors", "datum.host.risky-patterns", "datum.host.time-zone", "datum.host.unknown-fields", "datum.host.log-level",
            RT + "diagnostics.trace", RT + "diagnostics.capture.enabled", RT + "diagnostics.capture.directory", RT + "diagnostics.capture.max-runs",
            RT + "diagnostics.capture.max-bytes", RT + "diagnostics.capture.queue-bytes", RT + "diagnostics.report");
        assertThat(keys).doesNotHaveDuplicates().as("verify-max-bytes is the PDF route's, in PdfSettings").doesNotContain(RT + "verify-max-bytes");
    }

    @Test
    void aValueSetToTheDefaultItselfIsStillTheDefault() {
        Built built = build(b -> b.engine("endive").failFast(true).warmUpRuns(3).startupBudget(Duration.ofSeconds(30))
            .validationTimeLimit(Duration.ofSeconds(5)).validationMemory(32 * ProgramLimits.MIB).validationConcurrency(0)
            .pdfWait(Duration.ofSeconds(2)).formulaErrors("fail").unknownFields("").maxStrays(0));
        assertThat(built.settings().explain().entries()).allSatisfy(entry -> assertThat(entry.source()).as(entry.key()).isEqualTo(Source.DEFAULT));
        assertThat(built.settings()).isEqualTo(SandboxSettings.defaults());
    }

    // ---------------------------------------------------------------------------------------------- CONFIGURED

    @Test
    void whatIsSetAndInRangeIsUsedAsSetAndReportedAsConfigured() {
        ResourceHandle sandbox = ResourceHandle.of(Path.of("/etc/datum/sandbox.js"));
        Built built = build(b -> b.engine("other").allowBytecode(true).stopGrace(Duration.ofSeconds(9)).maxStrays(97).failFast(false)
            .warmUpRuns(0).startupBudget(Duration.ofSeconds(45)).shutdownGrace(Duration.ofSeconds(3))
            .validationTimeLimit(Duration.ofSeconds(8)).validationMemory(64 * ProgramLimits.MIB).validationConcurrency(4)
            .validationWait(Duration.ofSeconds(1)).pdfTimeLimit(Duration.ofSeconds(30)).pdfMemory(512 * ProgramLimits.MIB)
            .pdfConcurrency(3).pdfWait(Duration.ofSeconds(4)).sandboxProgram(sandbox)
            .formulaErrors("warn").riskyPatterns("allow").timeZone("America/Toronto").unknownFields("reject").logLevel("debug")
            .trace("all").captureEnabled(true).captureDirectory("/var/tmp/datum-captures").captureMaxRuns(5).captureMaxBytes(ProgramLimits.MIB)
            .captureQueueBytes(2 * ProgramLimits.MIB).report(false));
        SandboxSettings s = built.settings();
        assertThat(built.warnings()).isEmpty();
        assertThat(s.diagnostics()).isEqualTo(new SandboxSettings.Diagnostics(com.argusvane.datum.sandbox.diagnostics.TraceMode.ALL,
            new com.argusvane.datum.sandbox.diagnostics.CaptureSettings(true, Path.of("/var/tmp/datum-captures"), 5, ProgramLimits.MIB,
                2 * ProgramLimits.MIB), false));
        assertThat(s.engine()).isEqualTo(new SandboxSettings.Engine("other", true, Duration.ofSeconds(9), 97));
        assertThat(s.lifecycle()).isEqualTo(new SandboxSettings.Lifecycle(false, 0, Duration.ofSeconds(45), Duration.ofSeconds(3)));
        assertThat(s.validation()).isEqualTo(new SandboxSettings.Run(Duration.ofSeconds(8), 64 * ProgramLimits.MIB, 4, Duration.ofSeconds(1)));
        assertThat(s.pdf()).isEqualTo(new SandboxSettings.Run(Duration.ofSeconds(30), 512 * ProgramLimits.MIB, 3, Duration.ofSeconds(4)));
        assertThat(s.programs().sandbox()).isSameAs(sandbox);
        assertThat(s.programs().pdf()).isNull();
        assertThat(s.host()).isEqualTo(new SandboxSettings.Host("warn", "allow", "America/Toronto", "reject", "debug"));
        assertThat(s.explain().entries()).allSatisfy(entry -> {
            if (entry.key().equals(RT + "programs.pdf")) {
                assertThat(entry.source()).isEqualTo(Source.DEFAULT);
            } else {
                assertThat(entry.source()).as(entry.key()).isEqualTo(Source.CONFIGURED);
                assertThat(entry.asked()).isNull();
                assertThat(entry.warnings()).isEmpty();
            }
        });
        assertThat(built.entry(RT + "programs.sandbox").value()).isEqualTo(sandbox.description());
        assertThat(built.entry(RT + "validation.time-limit").value()).isEqualTo(Duration.ofSeconds(8));
        assertThat(s.validationSlots()).isEqualTo(4);
        assertThat(s.pdfSlots()).isEqualTo(3);
        ProgramLimits limits = s.limits(2 * ProgramLimits.MIB);
        assertThat(limits.validationSeconds()).isEqualTo(8);
        assertThat(limits.validationMemory()).isEqualTo(64 * ProgramLimits.MIB);
        assertThat(limits.validationConcurrency()).isEqualTo(4);
        assertThat(limits.validationWait()).isEqualTo(1);
        assertThat(limits.pdfSeconds()).isEqualTo(30);
        assertThat(limits.pdfMemory()).isEqualTo(512 * ProgramLimits.MIB);
        assertThat(limits.pdfConcurrency()).isEqualTo(3);
        assertThat(limits.maxBodyBytes()).isEqualTo(2 * ProgramLimits.MIB);
    }

    @Test
    void twoSettingsAreEqualWhenTheirEffectiveValuesAreWhateverWasAskedFor() {
        SandboxSettings clamped = build(b -> b.validationTimeLimit(Duration.ofHours(1))).settings();
        SandboxSettings exact = build(b -> b.validationTimeLimit(Duration.ofSeconds(60))).settings();
        assertThat(clamped).isEqualTo(exact).hasSameHashCodeAs(exact);
        assertThat(clamped.explain().get(RT + "validation.time-limit").source()).isEqualTo(Source.CLAMPED);
        assertThat(exact.explain().get(RT + "validation.time-limit").source()).isEqualTo(Source.CONFIGURED);
    }

    // ---------------------------------------------------------------------------------------------- CLAMPED

    /** One check of a clamped key: the effective value, the source, what was asked, and the WARN the build logged. */
    private static void clampedTo(Built built, String key, Object value, Object asked, String warning) {
        Entry entry = built.entry(key);
        assertThat(entry.source()).as(key).isEqualTo(Source.CLAMPED);
        assertThat(entry.value()).as(key).isEqualTo(value);
        assertThat(entry.asked()).as(key).isEqualTo(asked);
        assertThat(entry.bound()).as(key).isNotBlank();
        assertThat(entry.warnings()).as(key).contains(warning);
        assertThat(built.warnings()).as("the log is the report's own texts").contains(warning);
        assertThat(entry.toString()).contains("clamped from " + asked);
    }

    @Test
    void aValidationTimeLimitIsWholeSecondsWithinOneToSixty() {
        Built fraction = build(b -> b.validationTimeLimit(Duration.ofMillis(2500)));
        clampedTo(fraction, RT + "validation.time-limit", Duration.ofSeconds(2), Duration.ofMillis(2500),
            "datum.runtime.validation.time-limit = PT2.5S is not whole seconds; using 2 s.");
        assertThat(fraction.settings().validation().timeLimit()).isEqualTo(Duration.ofSeconds(2));
        Built high = build(b -> b.validationTimeLimit(Duration.ofHours(1)));
        clampedTo(high, RT + "validation.time-limit", Duration.ofSeconds(60), Duration.ofHours(1),
            "datum limit validationSeconds = 3600 is outside [1, 60]; using 60.");
        Built zero = build(b -> b.validationTimeLimit(Duration.ZERO));
        clampedTo(zero, RT + "validation.time-limit", Duration.ofSeconds(5), Duration.ZERO, "datum limit validationSeconds = 0 is outside [1, 60]; using 5.");
    }

    @Test
    void aValidationMemoryIsFourMibToOneGib() {
        clampedTo(build(b -> b.validationMemory(8L * 1024 * ProgramLimits.MIB)), RT + "validation.memory", 1024 * ProgramLimits.MIB,
            8L * 1024 * ProgramLimits.MIB, "datum limit validationMemory = 8589934592 is outside [4194304, 1073741824]; using 1073741824.");
        clampedTo(build(b -> b.validationMemory(ProgramLimits.MIB)), RT + "validation.memory", 4 * ProgramLimits.MIB, ProgramLimits.MIB,
            "datum limit validationMemory = 1048576 is outside [4194304, 1073741824]; using 4194304.");
    }

    @Test
    void aValidationConcurrencyIsZeroForOnePerCpuUpToSixtyFour() {
        clampedTo(build(b -> b.validationConcurrency(500)), RT + "validation.concurrency", 64, 500L,
            "datum limit validationConcurrency = 500 is outside [0, 64]; using 64.");
        Built negative = build(b -> b.validationConcurrency(-2));
        clampedTo(negative, RT + "validation.concurrency", 0, -2L, "datum limit validationConcurrency = -2 is outside [0, 64]; using 0.");
        assertThat(negative.settings().validationSlots()).isEqualTo(ProgramLimits.cpus());
    }

    @Test
    void aValidationWaitIsWholeSecondsFromZeroToTen() {
        clampedTo(build(b -> b.validationWait(Duration.ofSeconds(30))), RT + "validation.wait", Duration.ofSeconds(10), Duration.ofSeconds(30),
            "datum limit validationWait = 30 is outside [0, 10]; using 10.");
        clampedTo(build(b -> b.validationWait(Duration.ofMillis(1500))), RT + "validation.wait", Duration.ofSeconds(1), Duration.ofMillis(1500),
            "datum.runtime.validation.wait = PT1.5S is not whole seconds; using 1 s.");
        Built none = build(b -> b.validationWait(Duration.ZERO));
        assertThat(none.entry(RT + "validation.wait").source()).as("0 refuses at once, a choice and not a clamp").isEqualTo(Source.CONFIGURED);
        assertThat(none.settings().validation().slotWait()).isZero();
    }

    @Test
    void aPdfTimeLimitAndMemoryAreBoundedAsTheValidationOnesAre() {
        clampedTo(build(b -> b.pdfTimeLimit(Duration.ofSeconds(1000))), RT + "pdf.time-limit", Duration.ofSeconds(300), Duration.ofSeconds(1000),
            "datum limit pdfSeconds = 1000 is outside [1, 300]; using 300.");
        clampedTo(build(b -> b.pdfTimeLimit(Duration.ofMillis(15_400))), RT + "pdf.time-limit", Duration.ofSeconds(15), Duration.ofMillis(15_400),
            "datum.runtime.pdf.time-limit = PT15.4S is not whole seconds; using 15 s.");
        clampedTo(build(b -> b.pdfMemory(ProgramLimits.MIB)), RT + "pdf.memory", 32 * ProgramLimits.MIB, ProgramLimits.MIB,
            "datum limit pdfMemory = 1048576 is outside [33554432, 4294967296]; using 33554432.");
        clampedTo(build(b -> b.pdfMemory(8192L * ProgramLimits.MIB)), RT + "pdf.memory", 4096 * ProgramLimits.MIB, 8192L * ProgramLimits.MIB,
            "datum limit pdfMemory = 8589934592 is outside [33554432, 4294967296]; using 4294967296.");
    }

    /** A PDF slot count past 64 is told twice, as it was: the limits' text and the slot count's own. */
    @Test
    void aPdfConcurrencyAboveSixtyFourIsSixtyFourAndSaysSoTwice() {
        Built built = build(b -> b.pdfConcurrency(500));
        clampedTo(built, RT + "pdf.concurrency", 64, 500L, "datum limit pdfConcurrency = 500 is outside [0, 64]; using 64.");
        clampedTo(built, RT + "pdf.concurrency", 64, 500L, "datum.runtime.pdf.concurrency = 500 is above 64; using 64.");
        assertThat(built.settings().pdfSlots()).isEqualTo(64);
        assertThat(build(b -> { }).settings().pdfSlots()).as("0 is min(2, CPUs): a render is heavy").isEqualTo(Math.min(2, ProgramLimits.cpus()));
        Built negative = build(b -> b.pdfConcurrency(-1));
        assertThat(negative.settings().pdf().concurrency()).isZero();
        assertThat(negative.warnings()).containsExactly("datum limit pdfConcurrency = -1 is outside [0, 64]; using 0.");
    }

    @Test
    void aPdfWaitIsWholeSecondsFromZeroToTenInOneText() {
        clampedTo(build(b -> b.pdfWait(Duration.ofSeconds(30))), RT + "pdf.wait", Duration.ofSeconds(10), Duration.ofSeconds(30),
            "datum.runtime.pdf.wait = PT30S is not whole seconds from 0 to 10; using 10 s.");
        clampedTo(build(b -> b.pdfWait(Duration.ofSeconds(-5))), RT + "pdf.wait", Duration.ZERO, Duration.ofSeconds(-5),
            "datum.runtime.pdf.wait = PT-5S is not whole seconds from 0 to 10; using 0 s.");
        clampedTo(build(b -> b.pdfWait(Duration.ofMillis(2500))), RT + "pdf.wait", Duration.ofSeconds(2), Duration.ofMillis(2500),
            "datum.runtime.pdf.wait = PT2.5S is not whole seconds from 0 to 10; using 2 s.");
    }

    @Test
    void aStartupBudgetIsWholeSecondsFromOneSecondToFiveMinutes() {
        clampedTo(build(b -> b.startupBudget(Duration.ofHours(2))), RT + "startup-budget", Duration.ofMinutes(5), Duration.ofHours(2),
            "datum.runtime.startup-budget = PT2H is not whole seconds from 1 s to 300 s; using 300 s.");
        clampedTo(build(b -> b.startupBudget(Duration.ofMillis(900))), RT + "startup-budget", Duration.ofSeconds(1), Duration.ofMillis(900),
            "datum.runtime.startup-budget = PT0.9S is not whole seconds from 1 s to 300 s; using 1 s.");
        clampedTo(build(b -> b.startupBudget(Duration.ofMillis(45_500))), RT + "startup-budget", Duration.ofSeconds(45), Duration.ofMillis(45_500),
            "datum.runtime.startup-budget = PT45.5S is not whole seconds from 1 s to 300 s; using 45 s.");
        assertThat(SandboxSettings.clampStartupBudget(null)).isEqualTo(Duration.ofSeconds(30));
        assertThat(SandboxSettings.clampStartupBudget(Duration.ZERO)).isEqualTo(Duration.ofSeconds(1));
        assertThat(SandboxSettings.clampStartupBudget(Duration.ofSeconds(-5))).isEqualTo(Duration.ofSeconds(1));
        assertThat(SandboxSettings.clampStartupBudget(Duration.ofHours(2))).isEqualTo(Duration.ofMinutes(5));
    }

    @Test
    void theClampsOfOneBuildAreOneWarnEachAndTheReportCarriesTheSameTexts() {
        Built built = build(b -> b.validationTimeLimit(Duration.ofHours(1)).pdfWait(Duration.ofSeconds(30)).startupBudget(Duration.ofHours(2)));
        assertThat(built.warnings()).hasSize(3).isEqualTo(built.settings().explain().warnings());
        String text = built.settings().explain().toString();
        assertThat(text).startsWith("Datum sandbox settings:\n  datum.runtime.engine = endive (default)")
            .contains("\n  datum.runtime.validation.time-limit = PT1M (clamped from PT1H to whole seconds in [1, 60])")
            .contains("\n  datum.runtime.fail-fast = true (default)");
        assertThat(text.lines().count()).isEqualTo(1 + built.settings().explain().entries().size());
        assertThat(built.settings().toString()).isEqualTo(text);
    }

    // ---------------------------------------------------------------------------------------------- refusals

    @Test
    void whatCannotBeClampedIntoMeaningStopsTheBuildNamingTheProperty() {
        assertThatThrownBy(() -> SandboxSettings.builder().warmUpRuns(-3).build()).isInstanceOf(DatumConfigurationException.class)
            .hasMessageContaining("datum.runtime.warm-up-runs must be 0 or more, not -3.");
        assertThatThrownBy(() -> SandboxSettings.builder().shutdownGrace(Duration.ofSeconds(-10)).build())
            .isInstanceOf(DatumConfigurationException.class).hasMessageContaining("datum.runtime.shutdown-grace must not be negative");
        assertThatThrownBy(() -> SandboxSettings.builder().stopGrace(Duration.ofSeconds(-1)).build())
            .isInstanceOf(DatumConfigurationException.class).hasMessageContaining("datum.runtime.stop-grace is PT-1S; it must not be negative.");
        assertThatThrownBy(() -> SandboxSettings.builder().maxStrays(-1).build())
            .isInstanceOf(DatumConfigurationException.class).hasMessageContaining("datum.runtime.max-strays is -1");
        assertThat(SandboxSettings.builder().maxStrays(0).build().engine().maxStrays()).as("0 is one per CPU, at least two")
            .isEqualTo(EngineSettings.defaultMaxStrays());
        assertThat(EngineSettings.defaultMaxStrays()).isGreaterThanOrEqualTo(2);
    }

    @Test
    void aHostWordTheProgramDoesNotReadStopsTheBuildNamingTheProperty() {
        assertThatThrownBy(() -> SandboxSettings.builder().formulaErrors("warns").build()).hasMessageContaining("datum.host.formula-errors");
        assertThatThrownBy(() -> SandboxSettings.builder().formulaErrors("ignore").build()).hasMessageContaining("datum.host.formula-errors");
        assertThatThrownBy(() -> SandboxSettings.builder().riskyPatterns("maybe").build()).hasMessageContaining("datum.host.risky-patterns");
        assertThatThrownBy(() -> SandboxSettings.builder().timeZone("Not/AZone").build()).hasMessageContaining("datum.host.time-zone");
        assertThatThrownBy(() -> SandboxSettings.builder().unknownFields("drop").build()).hasMessageContaining("datum.host.unknown-fields");
        assertThatThrownBy(() -> SandboxSettings.builder().logLevel("loud").build()).hasMessageContaining("datum.host.log-level");
        // An unset or empty value is the default.
        SandboxSettings blank = SandboxSettings.builder().formulaErrors("").riskyPatterns("").timeZone(" ").unknownFields("").logLevel("").build();
        assertThat(blank.host()).isEqualTo(SandboxSettings.defaults().host());
        assertThat(blank.explain().get("datum.host.time-zone").source()).isEqualTo(Source.DEFAULT);
        assertThat(new SandboxSettings.Host("", "", " ", "", "")).isEqualTo(SandboxSettings.defaults().host());
    }

    @Test
    void theHostOptionsCarryTheHostWordsAndTheClock() {
        SandboxSettings.Host host = new SandboxSettings.Host("warn", "allow", "America/Toronto", "reject", "debug");
        assertThat(host.hostOptions(null).formulaErrors()).isEqualTo("warn");
        assertThat(host.hostOptions(null).zone()).isEqualTo(ZoneId.of("America/Toronto"));
        assertThat(host.unknownFields()).isEqualTo("reject");
        assertThat(host.logLevel()).isEqualTo("debug");
        assertThat(SandboxSettings.defaults().host().hostOptions(java.time.Clock.systemUTC()).formulaErrors()).isEqualTo("fail");
    }

    @Test
    void theEngineSettingsAreWhatTheEngineIsCreatedWith() {
        SandboxSettings s = SandboxSettings.builder().stopGrace(Duration.ofSeconds(2)).maxStrays(5).build();
        assertThat(s.engine().engineSettings()).isEqualTo(new EngineSettings(Duration.ofSeconds(2), 5));
        assertThat(SandboxSettings.ALLOW_BYTECODE).isEqualTo("datum.runtime.allow-bytecode");
    }

    @Test
    void theReportIsPlainDataWithNoNullAndAnImmutableList() {
        SettingsReport report = SandboxSettings.defaults().explain();
        assertThatThrownBy(() -> report.entries().add(Entry.defaulted("x", 1))).isInstanceOf(UnsupportedOperationException.class);
        assertThat(report.get("datum.runtime.nope")).isNull();
        assertThat(Entry.configured("k", "v").toString()).isEqualTo("k = v (configured)");
        assertThat(Entry.clamped("k", 2, 3, "[1, 2]", List.of("w")).toString()).isEqualTo("k = 2 (clamped from 3 to [1, 2])");
        assertThat(new SettingsReport(List.of()).toString()).isEqualTo("Datum sandbox settings:");
    }
}
