package com.argusvane.datum.sandbox.diagnostics;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.sandbox.diagnostics.SettingsReport.Entry;
import com.argusvane.datum.sandbox.wasi.EngineInfo;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** The effective-settings report: the block an operator reads, and the JSON a read serves without paths. */
class SandboxReportTest {

    private static SandboxReport report() {
        SettingsReport settings = new SettingsReport(List.of(
            Entry.defaulted("datum.runtime.engine", "endive"),
            Entry.clamped("datum.runtime.validation.time-limit", Duration.ofSeconds(60), Duration.ofSeconds(90), "whole seconds in [1, 60]", List.of("w")),
            Entry.configured("datum.runtime.programs.sandbox", "URL [https://user:s3cret@example.org/sandbox.js]"),
            Entry.replaced("datum.host.formula-errors", "warn"),
            Entry.configured(DirectoryCaptureSink.PROPERTY, "/var/tmp/captures")));
        return new SandboxReport(settings, new EngineInfo("endive", "0.9.1", "panama", "Panama runner, /opt/lib/libx.so"),
            List.of(new SandboxReport.ProgramLine("sandbox", "a".repeat(64), "1.2.0", "classpath:META-INF/datum/programs/x.js", null),
                new SandboxReport.ProgramLine("pdf", null, null, null, "The PDF program is not on the classpath.")),
            new SandboxReport.Trace("all", "the log datum.sandbox.trace (INFO)"),
            new SandboxReport.Capture(true, "the directory /var/tmp/captures", 20, 64L << 20, 64L << 20));
    }

    @Test
    void theBlockShowsEverySourceTheEngineTheProgramsAndTheDiagnostics() {
        String text = report().toString();
        assertThat(text.lines().toList()).containsExactly(
            "Datum sandbox settings:",
            "  datum.runtime.engine = endive (default)",
            "  datum.runtime.validation.time-limit = PT1M (clamped from PT1M30S to whole seconds in [1, 60])",
            "  datum.runtime.programs.sandbox = URL [https://***@example.org/sandbox.js] (configured)",
            "  datum.host.formula-errors = warn (replaced by the application's own input)",
            "  datum.runtime.diagnostics.capture.directory = /var/tmp/captures (configured)",
            "  engine: endive 0.9.1 (panama): Panama runner, /opt/lib/libx.so",
            "  program sandbox: sha256 " + "a".repeat(64) + ", ABI 1.2.0 (classpath:META-INF/datum/programs/x.js)",
            "  program pdf: unavailable (The PDF program is not on the classpath.)",
            "  trace: all, to the log datum.sandbox.trace (INFO)",
            "  capture: on, into the directory /var/tmp/captures (at most 20 runs and 67108864 bytes; 67108864 bytes may wait to be written)");
        assertThat(text).as("no password from a URL").doesNotContain("s3cret");
    }

    @Test
    @SuppressWarnings("unchecked")
    void theReadJsonLeavesOutTheDirectoryTheOverrideLocationsAndTheNotes() {
        Map<String, Object> read = report().toJson(true);
        assertThat(read).containsOnlyKeys("entries", "engine", "programs", "trace", "capture");
        Map<String, Map<String, Object>> entries = (Map<String, Map<String, Object>>) read.get("entries");
        assertThat(entries.get(DirectoryCaptureSink.PROPERTY)).containsEntry("value", "(not shown)").containsEntry("shown", false);
        assertThat(entries.get("datum.runtime.programs.sandbox")).containsEntry("value", "(not shown)");
        assertThat(entries.get("datum.runtime.engine")).containsEntry("value", "endive").containsEntry("source", "default");
        assertThat(entries.get("datum.runtime.validation.time-limit")).containsEntry("source", "clamped").containsEntry("asked", "PT1M30S")
            .containsEntry("bound", "whole seconds in [1, 60]");
        assertThat(entries.get("datum.host.formula-errors")).containsEntry("source", "replaced");
        assertThat((Map<String, Object>) read.get("engine")).doesNotContainKey("notes").containsEntry("mode", "panama");
        assertThat((Map<String, Object>) read.get("capture")).doesNotContainKey("to").containsEntry("enabled", true);
        assertThat(read.toString()).doesNotContain("/var/tmp").doesNotContain("/opt/lib").doesNotContain("s3cret");

        Map<String, Object> full = report().toJson(false);
        assertThat(full.toString()).contains("/var/tmp/captures").contains("/opt/lib/libx.so").doesNotContain("s3cret");
    }

    /**
     * A description of the trace or capture sink, the engine's notes and every entry are printed with a URL's
     * user and password and every query value masked, in the block and in both JSON forms.
     */
    @Test
    @SuppressWarnings("unchecked")
    void everyFieldIsScrubbedOfUserInfoAndQueryValues() {
        SettingsReport settings = new SettingsReport(List.of(
            Entry.configured("datum.runtime.programs.pdf", "URL [https://cdn.example/pdf.js?sig=abc123&exp=9]")));
        SandboxReport report = new SandboxReport(settings,
            new EngineInfo("endive", "0.9.1", "panama", "fetched from https://ops:hunter2@mirror/lib?token=t0k"),
            List.of(new SandboxReport.ProgramLine("sandbox", "a".repeat(64), "1.2.0", "https://u:p@host/x.js?key=k", null)),
            new SandboxReport.Trace("all", "the bus https://svc:pw@bus.example/topic?apikey=zzz"),
            new SandboxReport.Capture(true, "the bucket https://key:secret@minio/captures?token=abc", 20, 1, 1));
        String text = report.toString();
        String full = report.toJson(false).toString();
        String read = report.toJson(true).toString();
        for (String printed : List.of(text, full, read)) {
            assertThat(printed).doesNotContain("abc123").doesNotContain("hunter2").doesNotContain("t0k").doesNotContain(":p@")
                .doesNotContain("pw@").doesNotContain("zzz").doesNotContain("secret").doesNotContain("token=abc");
        }
        assertThat(text).contains("https://***@minio/captures?token=***").contains("https://***@bus.example/topic?apikey=***")
            .contains("fetched from https://***@mirror/lib?token=***").contains("pdf.js?sig=***&exp=***");
        assertThat(full).contains("https://***@minio/captures?token=***");
    }

    /** A concurrency of 0 stays the number 0 under value, what it comes to is a number beside it; the block says both. */
    @Test
    @SuppressWarnings("unchecked")
    void aResolvedSettingKeepsItsNumberAndShowsWhatItComesTo() {
        SettingsReport settings = new SettingsReport(List.of(
            Entry.defaulted("datum.runtime.validation.concurrency", 0).withResolved("one per CPU", 8),
            Entry.configured("datum.runtime.pdf.concurrency", 3)));
        SandboxReport report = new SandboxReport(settings, new EngineInfo("endive", "1", "panama", ""), List.of(),
            new SandboxReport.Trace("off", null), new SandboxReport.Capture(false, null, 1, 1, 1));
        Map<String, Map<String, Object>> entries = (Map<String, Map<String, Object>>) report.toJson(true).get("entries");
        assertThat(entries.get("datum.runtime.validation.concurrency")).containsEntry("value", 0).containsEntry("resolved", 8L);
        assertThat(entries.get("datum.runtime.pdf.concurrency")).containsEntry("value", 3).doesNotContainKey("resolved");
        assertThat(report.toString()).contains("datum.runtime.validation.concurrency = 0 (one per CPU = 8) (default)");
    }
}
