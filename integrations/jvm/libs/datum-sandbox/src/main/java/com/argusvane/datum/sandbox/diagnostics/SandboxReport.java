package com.argusvane.datum.sandbox.diagnostics;

import com.argusvane.datum.sandbox.wasi.EngineInfo;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import org.jspecify.annotations.Nullable;

/**
 * What the sandbox runs with, as an operator reads it: every effective setting and where it came from
 * ({@link SettingsReport}, the application's replaced inputs included), the engine, each program's sha256 and ABI, and the
 * state of the run trace and the failed-run capture. A host logs {@link #toString()} once at start, on the logger
 * {@value #LOGGER} at INFO, before the programs are proved; an actuator serves {@link #toJson(boolean)}; a capture's
 * {@code meta.json} holds the full JSON.
 *
 * <p>Nothing in it is a secret: settings, an engine's report, digests. A program override's location, a host's description of
 * its trace or capture sink, or an engine's notes could hold a URL's user and password or a token in its query, so every text
 * field is printed through {@link Guarded#scrub}: {@code scheme://user:password@} as {@code scheme://***@} and every query
 * value as {@code ***}, in {@link #toString()} and {@link #toJson(boolean)} alike. The capture directory, a
 * program override's location and the engine's notes (which can name a native library's path) are in the start log and the
 * capture's own {@code meta.json} only: {@link #toJson(boolean) toJson(true)}, the actuator's read, leaves them out.
 *
 * @param settings every key, with its source
 * @param engine what the engine reports
 * @param programs each program as its store read it
 * @param trace where the run trace goes
 * @param capture where failed runs are kept
 */
public record SandboxReport(SettingsReport settings, EngineInfo engine, List<ProgramLine> programs, Trace trace, Capture capture) {

    /** The logger of the startup block. */
    public static final String LOGGER = "datum.sandbox.settings";

    /** The keys whose value may be a location on this host, kept off a read. */
    static final Set<String> LOCAL_KEYS = Set.of(DirectoryCaptureSink.PROPERTY, "datum.runtime.programs.sandbox", "datum.runtime.programs.pdf");

    public SandboxReport {
        Objects.requireNonNull(settings, "settings");
        Objects.requireNonNull(engine, "engine");
        programs = List.copyOf(programs);
        Objects.requireNonNull(trace, "trace");
        Objects.requireNonNull(capture, "capture");
    }

    /**
     * One program as the store read it at start.
     *
     * @param program {@code sandbox} or {@code pdf}
     * @param sha256 the file's sha256, or null when it could not be read
     * @param abi the ABI the store reads for it (programs.json's, or the floor for an override), or null
     * @param source where it was read from, or null
     * @param unavailable why it could not be read, or null
     */
    public record ProgramLine(String program, @Nullable String sha256, @Nullable String abi, @Nullable String source, @Nullable String unavailable) {

        public ProgramLine {
            Objects.requireNonNull(program, "program");
        }
    }

    /**
     * The run trace's state.
     *
     * @param mode {@code off}, {@code failures} or {@code all}
     * @param to what the trace goes to ({@link RunTrace#describe()}), or null when off
     */
    public record Trace(String mode, @Nullable String to) {

        public Trace {
            Objects.requireNonNull(mode, "mode");
        }
    }

    /**
     * The failed-run capture's state.
     *
     * @param enabled whether failed runs are kept
     * @param to where ({@link RunCaptureSink#describe()}), or null when off
     * @param maxRuns the most captures kept
     * @param maxBytes the most bytes kept
     * @param queueBytes the most bytes waiting to be written
     */
    public record Capture(boolean enabled, @Nullable String to, int maxRuns, long maxBytes, long queueBytes) {
    }

    /** The startup block: the settings, then the engine, the programs, the trace and the capture, one indented line each. */
    @Override
    public String toString() {
        StringBuilder text = new StringBuilder("Datum sandbox settings:");
        for (SettingsReport.Entry entry : settings.entries()) {
            text.append("\n  ").append(scrub(entry.toString()));
        }
        text.append("\n  engine: ").append(scrub(engine.id())).append(' ').append(scrub(engine.version())).append(" (")
            .append(scrub(engine.mode())).append(')');
        if (!engine.notes().isEmpty()) {
            text.append(": ").append(scrub(engine.notes()));
        }
        for (ProgramLine program : programs) {
            text.append("\n  program ").append(program.program()).append(": ");
            if (program.unavailable() != null) {
                text.append("unavailable (").append(scrub(program.unavailable())).append(')');
            } else {
                text.append("sha256 ").append(program.sha256()).append(", ABI ").append(program.abi());
                if (program.source() != null) {
                    text.append(" (").append(scrub(program.source())).append(')');
                }
            }
        }
        text.append("\n  trace: ").append(trace.mode());
        if (trace.to() != null) {
            text.append(", to ").append(scrub(trace.to()));
        }
        text.append("\n  capture: ");
        if (capture.enabled()) {
            text.append("on, into ").append(capture.to() == null ? "-" : scrub(capture.to())).append(" (at most ").append(capture.maxRuns()).append(" runs and ")
                .append(capture.maxBytes()).append(" bytes; ").append(capture.queueBytes()).append(" bytes may wait to be written)");
        } else {
            text.append("off");
        }
        return text.toString();
    }

    /**
     * The report as plain data (maps, lists, strings, numbers, booleans), in the order of {@link #toString()}:
     * {@code entries} (key to value, source, and for a clamp what was asked and the bound), {@code engine}, {@code programs},
     * {@code trace} and {@code capture}.
     *
     * @param read true for a read an operator may expose (the actuator's): the capture directory and a program override's
     *     location show as {@code "(not shown)"} with {@code "shown": false}, the engine's notes, the programs' sources and
     *     where the trace and the capture go are left out
     */
    public Map<String, Object> toJson(boolean read) {
        Map<String, Object> json = new LinkedHashMap<>();
        Map<String, Object> entries = new LinkedHashMap<>();
        for (SettingsReport.Entry entry : settings.entries()) {
            Map<String, Object> one = new LinkedHashMap<>();
            boolean hidden = read && LOCAL_KEYS.contains(entry.key()) && entry.source() != SettingsReport.Source.DEFAULT;
            one.put("value", hidden ? "(not shown)" : plain(entry.value()));
            if (hidden) {
                one.put("shown", false);
            }
            one.put("source", entry.source().name().toLowerCase(java.util.Locale.ROOT));
            if (entry.asked() != null) {
                one.put("asked", hidden ? "(not shown)" : plain(entry.asked()));
            }
            if (entry.bound() != null) {
                one.put("bound", scrub(entry.bound()));
            }
            if (entry.resolved() != null) {
                one.put("resolved", entry.resolved().count());
            }
            entries.put(entry.key(), one);
        }
        json.put("entries", entries);
        Map<String, Object> engineJson = new LinkedHashMap<>();
        engineJson.put("id", scrub(engine.id()));
        engineJson.put("version", scrub(engine.version()));
        engineJson.put("mode", scrub(engine.mode()));
        if (!read && !engine.notes().isEmpty()) {
            engineJson.put("notes", scrub(engine.notes()));
        }
        json.put("engine", engineJson);
        List<Object> programsJson = new ArrayList<>();
        for (ProgramLine program : programs) {
            Map<String, Object> one = new LinkedHashMap<>();
            one.put("program", program.program());
            if (program.unavailable() != null) {
                one.put("available", false);
                if (!read) {
                    one.put("unavailable", scrub(program.unavailable()));
                }
            } else {
                one.put("sha256", program.sha256());
                one.put("abi", program.abi());
                if (!read && program.source() != null) {
                    one.put("source", scrub(program.source()));
                }
            }
            programsJson.add(one);
        }
        json.put("programs", programsJson);
        Map<String, Object> traceJson = new LinkedHashMap<>();
        traceJson.put("mode", trace.mode());
        if (!read && trace.to() != null) {
            traceJson.put("to", scrub(trace.to()));
        }
        json.put("trace", traceJson);
        Map<String, Object> captureJson = new LinkedHashMap<>();
        captureJson.put("enabled", capture.enabled());
        if (capture.enabled()) {
            if (!read && capture.to() != null) {
                captureJson.put("to", scrub(capture.to()));
            }
            captureJson.put("maxRuns", capture.maxRuns());
            captureJson.put("maxBytes", capture.maxBytes());
            captureJson.put("queueBytes", capture.queueBytes());
        }
        json.put("capture", captureJson);
        return json;
    }

    private static Object plain(Object value) {
        return value instanceof Number || value instanceof Boolean ? value : scrub(String.valueOf(value));
    }

    /** {@link Guarded#scrub}: a URL's user and password, and every query value, as {@code ***}. */
    static String scrub(String text) {
        return Guarded.scrub(text);
    }
}
