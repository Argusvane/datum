package com.argusvane.datum.sandbox.spring;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.springweb.autoconfigure.DatumWebAutoConfiguration;
import com.argusvane.datum.sandbox.runtime.TestRuntime;
import com.argusvane.datum.sandbox.runtime.DatumSandbox;
import com.argusvane.datum.sandbox.runtime.SandboxStatus;
import com.argusvane.datum.web.monitoring.DatumHealthContributors;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;

/** Health states and the datum endpoint's read and recheck, on the sandbox auto-configuration alone. */
class DatumEndpointTest {

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(DatumWebAutoConfiguration.class, DatumSandboxAutoConfiguration.class))
        .withPropertyValues("datum.runtime.warm-up-runs=1", "management.endpoints.web.exposure.include=datum");

    @Test
    void healthIsUpWithTheSlotsInUseAfterTheRuntimeIsProved() {
        runner.withBean(TestRuntime.class, TestRuntime::new).run(context -> {
            assertThat(context).hasNotFailed();
            DatumHealthContributors.Status status = context.getBean(DatumHealthContributors.class).evaluate().get("runtime");
            assertThat(status.up()).isTrue();
            assertThat(status.details()).containsEntry("state", "UP").containsEntry("validationSlotsInUse", 0)
                .containsEntry("pdfSlotsInUse", 0).containsEntry("runsInFlight", 0).containsEntry("engineMode", "jffi")
                .containsEntry("engine", TestRuntime.class.getName()).containsEntry("engineRelease", "test").containsEntry("pdfCapable", true);
        });
    }

    /**
     * On an engine that cannot run the PDF program the read says so in a fixed sentence: the notes reach neither
     * engineNotes nor pdfUnavailable there (the engine's notes can carry a file path).
     */
    @Test
    void theReadKeepsTheEngineNotesOutOfThePdfReasonToo() {
        TestRuntime engine = new TestRuntime();
        engine.mode = "bytecode";
        runner.withPropertyValues("datum.runtime.allow-bytecode=true").withBean(TestRuntime.class, () -> engine).run(context -> {
            assertThat(context).hasNotFailed();
            Map<String, Object> read = context.getBean(DatumEndpoint.class).status();
            assertThat(read).containsEntry("state", "UP").containsEntry("engineMode", "bytecode").doesNotContainKey("engineNotes")
                .containsEntry("pdfUnavailable", "The " + TestRuntime.class.getName() + " engine cannot run the PDF program here (mode bytecode).");
            assertThat(read.values()).as("no value of the read carries the notes").noneMatch(value -> String.valueOf(value).contains(engine.engineInfo().notes()));
        });
    }

    @Test
    void healthIsDownNamingTheReasonAndARecheckBringsTheRuntimeBack() {
        TestRuntime engine = new TestRuntime();
        engine.sandboxProbeFails = true;
        runner.withPropertyValues("datum.runtime.fail-fast=false").withBean(TestRuntime.class, () -> engine).run(context -> {
            assertThat(context).hasNotFailed();
            DatumHealthContributors.Status down = context.getBean(DatumHealthContributors.class).evaluate().get("runtime");
            assertThat(down.up()).isFalse();
            assertThat(down.details()).containsEntry("state", "DOWN");
            assertThat(down.details().get("reason").toString()).contains("abi_mismatch");

            DatumEndpoint endpoint = context.getBean(DatumEndpoint.class);
            assertThat(endpoint.status()).containsEntry("state", "DOWN").containsEntry("stuckRuns", 0).containsEntry("engineMode", "jffi")
                .as("the engine's free-text notes stay off the read, like the reason").doesNotContainKey("engineNotes").doesNotContainKey("reason");

            // Still broken: the recheck reports it and does not throw.
            assertThat(endpoint.recheck()).containsEntry("state", "DOWN").containsEntry("engineNotes", "A scripted test runtime.");

            engine.sandboxProbeFails = false;
            assertThat(endpoint.recheck()).containsEntry("state", "UP").doesNotContainKey("reason");
            assertThat(context.getBean(DatumSandbox.class).status().state()).isEqualTo(SandboxStatus.State.UP);
            assertThat(context.getBean(DatumHealthContributors.class).evaluate().get("runtime").up()).isTrue();
        });
    }

    @Test
    void theEndpointIsNotDefinedUnlessItIsExposed() {
        new ApplicationContextRunner()
            .withConfiguration(AutoConfigurations.of(DatumWebAutoConfiguration.class, DatumSandboxAutoConfiguration.class))
            .withPropertyValues("datum.runtime.warm-up-runs=1")
            .withBean(TestRuntime.class, TestRuntime::new)
            .run(context -> assertThat(context).hasNotFailed().doesNotHaveBean(DatumEndpoint.class));
    }

    // ============================================================================================== diagnostics

    /** The read's settings section: the report as JSON, the capture directory and other local places left out. */
    @Test
    @SuppressWarnings("unchecked")
    void theReadServesTheSettingsReportWithoutTheCaptureDirectory(@org.junit.jupiter.api.io.TempDir java.nio.file.Path temp) {
        java.nio.file.Path directory = temp.resolve("captures");
        runner.withPropertyValues("datum.runtime.diagnostics.capture.enabled=true", "datum.runtime.diagnostics.capture.directory=" + directory,
                "datum.runtime.validation.time-limit=90s")
            .withBean(TestRuntime.class, TestRuntime::new).run(context -> {
                assertThat(context).hasNotFailed();
                Map<String, Object> read = context.getBean(DatumEndpoint.class).status();
                assertThat(read).containsKey("settings");
                Map<String, Object> settings = (Map<String, Object>) read.get("settings");
                assertThat(settings).containsOnlyKeys("entries", "engine", "programs", "trace", "capture");
                Map<String, Map<String, Object>> entries = (Map<String, Map<String, Object>>) settings.get("entries");
                assertThat(entries.get("datum.runtime.validation.time-limit")).containsEntry("source", "clamped").containsEntry("value", "PT1M");
                assertThat(entries.get("datum.runtime.engine")).as("the application's own runtime bean")
                    .containsEntry("source", "replaced").containsEntry("value", TestRuntime.class.getName());
                assertThat(entries.get("datum.runtime.diagnostics.capture.directory")).containsEntry("value", "(not shown)");
                // A concurrency of 0 is the number 0, with what it comes to here beside it (never a text in its place).
                assertThat(entries.get("datum.runtime.validation.concurrency")).containsEntry("value", 0)
                    .containsEntry("resolved", (long) com.argusvane.datum.sandbox.protocol.ProgramLimits.cpus());
                assertThat(entries.get("datum.runtime.pdf.concurrency").get("value")).isEqualTo(0);
                assertThat(entries.get("datum.runtime.pdf.concurrency").get("resolved")).isInstanceOf(Long.class);
                assertThat(String.valueOf(read)).doesNotContain(directory.toString()).doesNotContain("A scripted test runtime.");
                assertThat((java.util.List<Map<String, Object>>) settings.get("programs")).extracting(program -> program.get("abi"))
                    .doesNotContainNull();
                // Health shows the capture's counters, as it is on.
                DatumHealthContributors.Status health = context.getBean(DatumHealthContributors.class).evaluate().get("runtime");
                assertThat(health.details()).containsEntry("capture", Map.of("dropped", 0L, "failed", 0L));
                assertThat(java.nio.file.Files.isDirectory(directory)).as("made at start").isTrue();
            });
    }

    @Test
    void healthShowsNoCaptureCountersWhileTheCaptureIsOff() {
        runner.withBean(TestRuntime.class, TestRuntime::new).run(context -> {
            DatumHealthContributors.Status health = context.getBean(DatumHealthContributors.class).evaluate().get("runtime");
            assertThat(health.details()).doesNotContainKey("capture");
            assertThat(context.getBean(DatumEndpoint.class).status()).containsKey("settings");
        });
    }

    /** An application's RunTrace and RunCaptureSink beans are the seams' implementations; the mode and bounds stay the settings'. */
    @Test
    void anApplicationsTraceAndCaptureSinkBeansAreUsed() {
        java.util.List<String> lines = java.util.Collections.synchronizedList(new java.util.ArrayList<>());
        java.util.List<String> captured = java.util.Collections.synchronizedList(new java.util.ArrayList<>());
        TestRuntime engine = new TestRuntime();
        runner.withPropertyValues("datum.runtime.diagnostics.trace=all", "datum.runtime.diagnostics.capture.enabled=true")
            .withBean(TestRuntime.class, () -> engine)
            .withBean(com.argusvane.datum.sandbox.diagnostics.RunTrace.class, () -> com.argusvane.datum.sandbox.diagnostics.RunTrace.lines(lines::add))
            .withBean(com.argusvane.datum.sandbox.diagnostics.RunCaptureSink.class, () -> new com.argusvane.datum.sandbox.diagnostics.RunCaptureSink() {
                @Override
                public long write(com.argusvane.datum.sandbox.diagnostics.RunCapture capture) {
                    captured.add(capture.id());
                    return capture.bytes();
                }

                @Override
                public void remove(String id) {
                }
            })
            .run(context -> {
                assertThat(context).hasNotFailed();
                assertThat(lines).as("the proofs and the warm-up, traced through the bean").hasSize(3);
                engine.terminate = com.argusvane.datum.sandbox.wasi.Termination.TRAP;
                DatumSandbox sandbox = context.getBean(DatumSandbox.class);
                org.assertj.core.api.Assertions.catchThrowable(() -> sandbox.sandbox().validate(TestRuntime.json(
                    "{\"formId\":\"f\",\"form\":{\"id\":\"root\",\"type\":\"form\",\"configuration\":{},\"children\":{\"content\":[]}},"
                        + "\"values\":{},\"locale\":\"en\"}"), java.util.List.of(), false));
                long until = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(10);
                while (captured.isEmpty() && System.nanoTime() < until) {
                    Thread.sleep(5);
                }
                assertThat(captured).hasSize(1);
                assertThat(lines.get(lines.size() - 1)).contains("outcome=trap").contains("capture=" + captured.get(0));
            });
    }

    /** The binding's own engine is no replacement; an application's EngineSettings, ProgramLimits or HostOptions bean is. */
    @Test
    void theBindingsOwnBeansAreNotReplacementsButAnApplicationsAre() {
        new ApplicationContextRunner()
            .withConfiguration(AutoConfigurations.of(DatumWebAutoConfiguration.class, DatumSandboxAutoConfiguration.class))
            // The real engine (bytecode here, so allowed), and a program override that is not there: the start goes DOWN at once
            // instead of proving on bytecode, and the report is all this test reads.
            .withPropertyValues("datum.runtime.warm-up-runs=1", "datum.runtime.engine=endive", "datum.runtime.allow-bytecode=true",
                "datum.runtime.fail-fast=false", "datum.runtime.programs.sandbox=classpath:datum-test-no-such-program.js")
            .run(context -> {
                assertThat(context).hasNotFailed();
                assertThat(context.getBean(DatumSandbox.class).explain().entries()).as("the binding's own engine and beans")
                    .noneMatch(entry -> entry.source() == com.argusvane.datum.sandbox.diagnostics.SettingsReport.Source.REPLACED);
            });
        new ApplicationContextRunner()
            .withConfiguration(AutoConfigurations.of(DatumWebAutoConfiguration.class, DatumSandboxAutoConfiguration.class))
            // The real engine (bytecode here, so allowed), and a program override that is not there: the start goes DOWN at once
            // instead of proving on bytecode, and the report is all this test reads.
            .withPropertyValues("datum.runtime.warm-up-runs=1", "datum.runtime.engine=endive", "datum.runtime.allow-bytecode=true",
                "datum.runtime.fail-fast=false", "datum.runtime.programs.sandbox=classpath:datum-test-no-such-program.js")
            .withBean(com.argusvane.datum.sandbox.wasi.EngineSettings.class,
                () -> new com.argusvane.datum.sandbox.wasi.EngineSettings(java.time.Duration.ofSeconds(9), 7))
            .withBean(com.argusvane.datum.sandbox.protocol.ProgramLimits.class,
                () -> com.argusvane.datum.sandbox.protocol.ProgramLimits.builder().validationSeconds(9L).build())
            .run(context -> {
                assertThat(context).hasNotFailed();
                com.argusvane.datum.sandbox.diagnostics.SettingsReport report = context.getBean(DatumSandbox.class).explain();
                assertThat(report.get("datum.runtime.stop-grace").source()).isEqualTo(com.argusvane.datum.sandbox.diagnostics.SettingsReport.Source.REPLACED);
                assertThat(report.get("datum.runtime.max-strays").value()).isEqualTo(7);
                assertThat(report.get("datum.runtime.validation.time-limit").value()).isEqualTo(java.time.Duration.ofSeconds(9));
                assertThat(report.get("datum.runtime.engine").source()).isEqualTo(com.argusvane.datum.sandbox.diagnostics.SettingsReport.Source.DEFAULT);
            });
    }

    /**
     * An application's engine bean that happens to carry the binding's bean name is still the application's: the report shows
     * its engine, stop grace and stray bound as REPLACED (the binding's own is told by its factory method, not by its name).
     */
    @Test
    void anApplicationsEngineNamedLikeTheBindingsIsStillReplaced() {
        runner.withBean(DatumSandboxAutoConfiguration.GUEST_RUNTIME, com.argusvane.datum.sandbox.wasi.GuestRuntime.class, TestRuntime::new)
            .run(context -> {
                assertThat(context).hasNotFailed();
                com.argusvane.datum.sandbox.diagnostics.SettingsReport report = context.getBean(DatumSandbox.class).explain();
                for (String key : java.util.List.of("datum.runtime.engine", "datum.runtime.stop-grace", "datum.runtime.max-strays")) {
                    assertThat(report.get(key).source()).as(key).isEqualTo(com.argusvane.datum.sandbox.diagnostics.SettingsReport.Source.REPLACED);
                }
                assertThat(report.get("datum.runtime.stop-grace").value()).isEqualTo("(the supplied runtime's own)");
            });
    }
}
