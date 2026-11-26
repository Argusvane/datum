package com.argusvane.datum.sandbox.runtime;

import com.argusvane.datum.core.DatumConfigurationException;
import com.argusvane.datum.core.io.ResourceHandle;
import com.argusvane.datum.sandbox.diagnostics.CaptureSettings;
import com.argusvane.datum.sandbox.diagnostics.SettingsReport;
import com.argusvane.datum.sandbox.diagnostics.TraceMode;
import com.argusvane.datum.sandbox.diagnostics.SettingsReport.Entry;
import com.argusvane.datum.sandbox.protocol.HostOptions;
import com.argusvane.datum.sandbox.protocol.ProgramLimits;
import com.argusvane.datum.sandbox.protocol.ProgramLimits.Bounds;
import com.argusvane.datum.sandbox.protocol.RunSettings;
import com.argusvane.datum.sandbox.wasi.EngineSettings;
import java.time.Clock;
import java.time.DateTimeException;
import java.time.Duration;
import java.time.ZoneId;
import java.nio.file.InvalidPathException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.function.Consumer;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * How the sandbox runs, as one framework-free value: the engine, the lifecycle, the two
 * programs' runs, the program overrides, the host's context keys and the diagnostics ({@code datum.runtime.diagnostics.*}),
 * with their defaults and every clamp in one place.
 * A framework binding maps its configuration onto {@link #builder()} ({@code datum.runtime.*} and {@code datum.host.*} in
 * Spring Boot; the same words in the FastAPI host), and a plain-Java host uses the builder directly; neither decides a bound.
 *
 * <p>The tree is immutable and its records hold the <em>effective</em> values: what {@link Builder#build()} made of what
 * was set. A value outside its bounds is clamped (a whole-second budget, a slot count, a wait) and one WARN names it, in the
 * same texts whichever binding built the settings. A value that cannot be clamped into meaning anything (a negative warm-up count, a host word the
 * program does not read) stops the build with a {@link DatumConfigurationException} naming the property.
 *
 * <p>{@link #explain()} answers where each value came from, per property key: {@code DEFAULT} (nothing set, or set to the
 * default itself), {@code CONFIGURED}, or {@code CLAMPED} with what was asked for and the rule that changed it. The WARNs
 * logged at build are the report's own texts, so the log and the report cannot disagree. Two settings are equal when their
 * effective values are, whatever was asked for.
 *
 * <p>The bounds themselves are {@link ProgramLimits}' constants; this class is the one place a configured value is clamped
 * against them and reported. ({@code verify-max-bytes} is the PDF verify route's size cap and lives in datum-pdf's
 * {@code PdfSettings}, under the same property key.)
 */
public final class SandboxSettings {

    private static final Logger LOG = LoggerFactory.getLogger(SandboxSettings.class);

    /** The default engine id: Endive, in process. */
    public static final String DEFAULT_ENGINE = "endive";
    /** The default of {@code datum.runtime.warm-up-runs}. */
    public static final int DEFAULT_WARM_UP_RUNS = 3;
    /** The default of {@code datum.runtime.shutdown-grace}. */
    public static final Duration DEFAULT_SHUTDOWN_GRACE = Duration.ofSeconds(10);
    /** The default of {@code datum.runtime.startup-budget}. */
    public static final Duration DEFAULT_STARTUP_BUDGET = Duration.ofSeconds(30);
    /** The shortest startup budget; a configured value below it is clamped. */
    public static final Duration MIN_STARTUP_BUDGET = Duration.ofSeconds(1);
    /** The longest startup budget; a configured value above it is clamped. */
    public static final Duration MAX_STARTUP_BUDGET = Duration.ofMinutes(5);
    /** The longest a PDF run may wait for a slot, as for a validation slot (0 to 10 s). */
    public static final Duration MAX_WAIT = Duration.ofSeconds(10);

    /** The property of {@link Engine#allowBytecode()}, which the bytecode refusal names. */
    public static final String ALLOW_BYTECODE = "datum.runtime.allow-bytecode";

    /** The words {@code datum.host.formula-errors} takes: the program's two. */
    public static final List<String> FORMULA_ERROR_WORDS = List.of("fail", "warn");

    private static final String RUNTIME = "datum.runtime.";
    private static final String HOST = "datum.host.";
    /** The diagnostics' keys. */
    public static final String DIAGNOSTICS = RUNTIME + "diagnostics.";

    // ------------------------------------------------------------------------------------------------ the tree

    /**
     * Which engine runs QuickJS and how it treats a stopped run.
     *
     * @param id the engine's id, the value that selects its {@code GuestRuntimeProvider} ({@code endive}, the default)
     * @param allowBytecode whether an engine that runs the programs as JVM bytecode may start; false refuses the start
     *     whatever {@code failFast} says
     * @param stopGrace how long a stopped run is given to end before its output is read as it stands; not negative
     * @param maxStrays how many stopped runs may outlive their grace before new runs are refused; at least 1 (the
     *     configured 0 is one per CPU, at least two, resolved here)
     */
    public record Engine(String id, boolean allowBytecode, Duration stopGrace, int maxStrays) {

        public Engine {
            Objects.requireNonNull(id, "id");
            Objects.requireNonNull(stopGrace, "stopGrace");
        }

        /** What the engine is created with besides its memory limits. */
        public EngineSettings engineSettings() {
            return new EngineSettings(stopGrace, maxStrays);
        }
    }

    /**
     * How the runtime starts and stops.
     *
     * @param failFast whether a runtime that cannot prove its programs at start stops the host
     * @param warmUpRuns smoke runs at start (0: none)
     * @param startupBudget the wall-time budget of the proof runs (whole seconds, 1 s to 5 min): a loaded host or a cold JIT
     *     must not refuse to start for a run a request would never be given less than its own budget for
     * @param shutdownGrace how long a stop waits for the runs in flight before cancelling them
     */
    public record Lifecycle(boolean failFast, int warmUpRuns, Duration startupBudget, Duration shutdownGrace) {

        public Lifecycle {
            Objects.requireNonNull(startupBudget, "startupBudget");
            Objects.requireNonNull(shutdownGrace, "shutdownGrace");
        }
    }

    /**
     * One program's runs.
     *
     * @param timeLimit the wall time one run may take (whole seconds)
     * @param memoryBytes the linear memory one run may use
     * @param concurrency runs at once; 0 is the default (validation: one per CPU, PDF: min(2, CPUs))
     * @param slotWait how long a run waits for a free slot before 503 {@code server.busy} (whole seconds; 0 refuses at once)
     */
    public record Run(Duration timeLimit, long memoryBytes, int concurrency, Duration slotWait) {

        public Run {
            Objects.requireNonNull(timeLimit, "timeLimit");
            Objects.requireNonNull(slotWait, "slotWait");
        }
    }

    /**
     * Program files to run instead of datum-programs' (still proved by the ABI probe, read again by a recheck).
     *
     * @param sandbox the sandbox program, or null for the packaged one
     * @param pdf the PDF program, or null for the packaged one
     */
    public record Programs(@Nullable ResourceHandle sandbox, @Nullable ResourceHandle pdf) {
    }

    /**
     * {@code datum.host.*}: the keys the host sets on every validation context. A word the program does not read stops the
     * build naming the property, as Spring Boot fails an enum it cannot bind; an unset or empty value is the default.
     *
     * @param formulaErrors what a formula that cannot be evaluated does: {@code fail} (the default) or {@code warn}
     * @param riskyPatterns a regular expression that repeats a repeat: {@code refuse} (the default) or {@code allow}
     * @param timeZone the zone {@code today()} and the clock-dependent rules read; null is the JVM's default
     * @param unknownFields an answer the form has no component for: {@code strip} (the default), {@code keep} or {@code reject}
     * @param logLevel how much of a run's log the program keeps and the host relays: off, error, warn, info, debug
     */
    public record Host(String formulaErrors, String riskyPatterns, @Nullable String timeZone, String unknownFields, String logLevel) {

        public Host {
            formulaErrors = word(HOST + "formula-errors", formulaErrors, FORMULA_ERROR_WORDS, "fail");
            riskyPatterns = word(HOST + "risky-patterns", riskyPatterns, HostOptions.RISKY_PATTERNS, "refuse");
            timeZone = zone(timeZone);
            unknownFields = word(HOST + "unknown-fields", unknownFields, RunSettings.UNKNOWN_FIELDS, "strip");
            logLevel = word(HOST + "log-level", logLevel, RunSettings.LOG_LEVELS, "warn");
        }

        /** The host options of every validation context. */
        public HostOptions hostOptions(@Nullable Clock clock) {
            return new HostOptions(formulaErrors, riskyPatterns, timeZone, clock == null ? Clock.systemUTC() : clock);
        }
    }

    /**
     * {@code datum.runtime.diagnostics.*}: what the sandbox tells an operator about its runs.
     *
     * @param trace which runs get a trace line ({@code off} by default)
     * @param capture whether failed runs are kept, where and how many (off by default)
     * @param report whether the effective-settings report is logged at start (true by default)
     */
    public record Diagnostics(TraceMode trace, CaptureSettings capture, boolean report) {

        public Diagnostics {
            Objects.requireNonNull(trace, "trace");
            Objects.requireNonNull(capture, "capture");
        }

        /** Trace off, capture off, report on. */
        public static Diagnostics defaults() {
            return new Diagnostics(TraceMode.OFF, CaptureSettings.off(), true);
        }

        /** Whether a run is watched at all: the trace or the capture is on. With neither, nothing is done per run for them. */
        public boolean watchesRuns() {
            return trace != TraceMode.OFF || capture.enabled();
        }
    }

    private final Engine engine;
    private final Lifecycle lifecycle;
    private final Run validation;
    private final Run pdf;
    private final Programs programs;
    private final Host host;
    private final Diagnostics diagnostics;
    /** One entry per key: the provenance the effective values do not carry. Not part of equality. */
    private final SettingsReport report;

    private SandboxSettings(Engine engine, Lifecycle lifecycle, Run validation, Run pdf, Programs programs, Host host,
                            Diagnostics diagnostics, SettingsReport report) {
        this.engine = engine;
        this.lifecycle = lifecycle;
        this.validation = validation;
        this.pdf = pdf;
        this.programs = programs;
        this.host = host;
        this.diagnostics = diagnostics;
        this.report = report;
    }

    /** The engine. */
    public Engine engine() {
        return engine;
    }

    /** The lifecycle. */
    public Lifecycle lifecycle() {
        return lifecycle;
    }

    /** The sandbox program's runs. */
    public Run validation() {
        return validation;
    }

    /** The PDF program's runs. */
    public Run pdf() {
        return pdf;
    }

    /** The program overrides. */
    public Programs programs() {
        return programs;
    }

    /** The host's context keys. */
    public Host host() {
        return host;
    }

    /** The diagnostics: the run trace, the failed-run capture and the startup report. */
    public Diagnostics diagnostics() {
        return diagnostics;
    }

    /** What an application that set nothing runs with. */
    public static SandboxSettings defaults() {
        return builder().build();
    }

    /** A builder over the defaults; each setter takes what a configuration holds, null meaning "not set". */
    public static Builder builder() {
        return new Builder();
    }

    /** Every key with its effective value and where it came from. */
    public SettingsReport explain() {
        return report;
    }

    // ------------------------------------------------------------------------------------------------ derived values

    /**
     * The budgets, slots and sizes of both programs as the protocol reads them. The values are the effective ones, so no
     * clamp is left to do here; the body cap is the one value that is not this tree's ({@code datum.web.api.max-body-size}),
     * clamped by {@link ProgramLimits}.
     *
     * @param maxBodyBytes the largest submission body, or null for the default
     */
    public ProgramLimits limits(@Nullable Long maxBodyBytes) {
        return ProgramLimits.builder()
            .validationSeconds(validation.timeLimit().toSeconds())
            .validationMemory(validation.memoryBytes())
            .validationConcurrency((long) validation.concurrency())
            .validationWait(validation.slotWait().toSeconds())
            .pdfSeconds(pdf.timeLimit().toSeconds())
            .pdfMemory(pdf.memoryBytes())
            .pdfConcurrency((long) pdf.concurrency())
            .maxBodyBytes(maxBodyBytes)
            .build();
    }

    /** Validation slots: the setting, or one per CPU this JVM may use for 0. */
    public int validationSlots() {
        return validation.concurrency() > 0 ? validation.concurrency() : ProgramLimits.cpus();
    }

    /** PDF slots: the setting, or min(2, CPUs) for 0 (a render is heavy, so fewer by default than validations). */
    public int pdfSlots() {
        return pdf.concurrency() > 0 ? pdf.concurrency() : Math.min(2, ProgramLimits.cpus());
    }

    /** The program overrides as a store over the given class loader's packaged programs. */
    public ProgramStore programStore(ClassLoader loader) {
        return new ProgramStore(Objects.requireNonNull(loader, "loader"), programs.sandbox(), programs.pdf());
    }

    @Override
    public boolean equals(Object other) {
        return other instanceof SandboxSettings that && engine.equals(that.engine) && lifecycle.equals(that.lifecycle)
            && validation.equals(that.validation) && pdf.equals(that.pdf) && programs.equals(that.programs) && host.equals(that.host)
            && diagnostics.equals(that.diagnostics);
    }

    @Override
    public int hashCode() {
        return Objects.hash(engine, lifecycle, validation, pdf, programs, host, diagnostics);
    }

    @Override
    public String toString() {
        return report.toString();
    }

    // ------------------------------------------------------------------------------------------------ the builder

    /**
     * Records what was set, then resolves it all in {@link #build()}: defaults for what was not, bounds for what was, one WARN
     * per clamped key, a refusal for what cannot be clamped into meaning. Every setter takes a nullable value, so a binding
     * passes whatever its configuration holds.
     */
    public static final class Builder {

        private @Nullable String engineId;
        private @Nullable Boolean allowBytecode;
        private @Nullable Duration stopGrace;
        private @Nullable Integer maxStrays;
        private @Nullable Boolean failFast;
        private @Nullable Integer warmUpRuns;
        private @Nullable Duration startupBudget;
        private @Nullable Duration shutdownGrace;
        private final RunValues validation = new RunValues();
        private final RunValues pdf = new RunValues();
        private @Nullable ResourceHandle sandboxProgram;
        private @Nullable ResourceHandle pdfProgram;
        private @Nullable String formulaErrors;
        private @Nullable String riskyPatterns;
        private @Nullable String timeZone;
        private @Nullable String unknownFields;
        private @Nullable String logLevel;
        private @Nullable String trace;
        private @Nullable Boolean captureEnabled;
        private @Nullable String captureDirectory;
        private @Nullable Integer captureMaxRuns;
        private @Nullable Long captureMaxBytes;
        private @Nullable Long captureQueueBytes;
        private @Nullable Boolean report;
        private Consumer<String> warnings = LOG::warn;

        private Builder() {
        }

        /** {@code datum.runtime.engine}. */
        public Builder engine(@Nullable String id) { this.engineId = id; return this; }
        /** {@code datum.runtime.allow-bytecode}. */
        public Builder allowBytecode(@Nullable Boolean value) { this.allowBytecode = value; return this; }
        /** {@code datum.runtime.stop-grace}. */
        public Builder stopGrace(@Nullable Duration value) { this.stopGrace = value; return this; }
        /** {@code datum.runtime.max-strays} (0: one per CPU, at least two). */
        public Builder maxStrays(@Nullable Integer value) { this.maxStrays = value; return this; }
        /** {@code datum.runtime.fail-fast}. */
        public Builder failFast(@Nullable Boolean value) { this.failFast = value; return this; }
        /** {@code datum.runtime.warm-up-runs}. */
        public Builder warmUpRuns(@Nullable Integer value) { this.warmUpRuns = value; return this; }
        /** {@code datum.runtime.startup-budget}. */
        public Builder startupBudget(@Nullable Duration value) { this.startupBudget = value; return this; }
        /** {@code datum.runtime.shutdown-grace}. */
        public Builder shutdownGrace(@Nullable Duration value) { this.shutdownGrace = value; return this; }

        /** {@code datum.runtime.validation.time-limit}. */
        public Builder validationTimeLimit(@Nullable Duration value) { validation.timeLimit = value; return this; }
        /** {@code datum.runtime.validation.memory}, bytes. */
        public Builder validationMemory(@Nullable Long value) { validation.memory = value; return this; }
        /** {@code datum.runtime.validation.concurrency}. */
        public Builder validationConcurrency(@Nullable Integer value) { validation.concurrency = value; return this; }
        /** {@code datum.runtime.validation.wait}. */
        public Builder validationWait(@Nullable Duration value) { validation.wait = value; return this; }

        /** {@code datum.runtime.pdf.time-limit}. */
        public Builder pdfTimeLimit(@Nullable Duration value) { pdf.timeLimit = value; return this; }
        /** {@code datum.runtime.pdf.memory}, bytes. */
        public Builder pdfMemory(@Nullable Long value) { pdf.memory = value; return this; }
        /** {@code datum.runtime.pdf.concurrency}. */
        public Builder pdfConcurrency(@Nullable Integer value) { pdf.concurrency = value; return this; }
        /** {@code datum.runtime.pdf.wait}. */
        public Builder pdfWait(@Nullable Duration value) { pdf.wait = value; return this; }

        /** {@code datum.runtime.programs.sandbox}. */
        public Builder sandboxProgram(@Nullable ResourceHandle value) { this.sandboxProgram = value; return this; }
        /** {@code datum.runtime.programs.pdf}. */
        public Builder pdfProgram(@Nullable ResourceHandle value) { this.pdfProgram = value; return this; }

        /** {@code datum.host.formula-errors}. */
        public Builder formulaErrors(@Nullable String value) { this.formulaErrors = value; return this; }
        /** {@code datum.host.risky-patterns}. */
        public Builder riskyPatterns(@Nullable String value) { this.riskyPatterns = value; return this; }
        /** {@code datum.host.time-zone}. */
        public Builder timeZone(@Nullable String value) { this.timeZone = value; return this; }
        /** {@code datum.host.unknown-fields}. */
        public Builder unknownFields(@Nullable String value) { this.unknownFields = value; return this; }
        /** {@code datum.host.log-level}. */
        public Builder logLevel(@Nullable String value) { this.logLevel = value; return this; }

        /** {@code datum.runtime.diagnostics.trace}: {@code off} (the default), {@code failures} or {@code all}. */
        public Builder trace(@Nullable String value) { this.trace = value; return this; }
        /** {@code datum.runtime.diagnostics.capture.enabled}. */
        public Builder captureEnabled(@Nullable Boolean value) { this.captureEnabled = value; return this; }
        /** {@code datum.runtime.diagnostics.capture.directory}. */
        public Builder captureDirectory(@Nullable String value) { this.captureDirectory = value; return this; }
        /** {@code datum.runtime.diagnostics.capture.max-runs}. */
        public Builder captureMaxRuns(@Nullable Integer value) { this.captureMaxRuns = value; return this; }
        /** {@code datum.runtime.diagnostics.capture.max-bytes}. */
        public Builder captureMaxBytes(@Nullable Long value) { this.captureMaxBytes = value; return this; }
        /** {@code datum.runtime.diagnostics.capture.queue-bytes}. */
        public Builder captureQueueBytes(@Nullable Long value) { this.captureQueueBytes = value; return this; }
        /** {@code datum.runtime.diagnostics.report}. */
        public Builder report(@Nullable Boolean value) { this.report = value; return this; }

        /** Where the clamp warnings go (SLF4J WARN by default); tests and a host with its own log read them here. */
        public Builder warnings(Consumer<String> sink) {
            this.warnings = Objects.requireNonNull(sink, "sink");
            return this;
        }

        /**
         * The settings: what was not set at its default, what was set clamped to its bounds with one WARN per clamped key.
         *
         * @throws DatumConfigurationException for a negative warm-up count, shutdown grace or stop grace, a negative
         *     max-strays, a host word the program does not read, a trace word that is none of off, failures and all, a capture
         *     directory that is not a path, or a capture bound below 1
         */
        public SandboxSettings build() {
            List<Entry> entries = new ArrayList<>();

            // As the engines are selected (GuestRuntimes): an id in another case or with blanks around it is the same engine, so
            // the report never shows `Endive` as a replacement of the endive it runs.
            String id = engineId == null ? DEFAULT_ENGINE : engineId(engineId);
            entries.add(plain(RUNTIME + "engine", id, DEFAULT_ENGINE, engineId != null));
            boolean bytecode = allowBytecode != null && allowBytecode;
            entries.add(plain(ALLOW_BYTECODE, bytecode, false, allowBytecode != null));
            Duration grace = stopGrace == null ? EngineSettings.DEFAULT_STOP_GRACE : stopGrace;
            if (grace.isNegative()) {
                throw new DatumConfigurationException(RUNTIME + "stop-grace", RUNTIME + "stop-grace is " + stopGrace + "; it must not be negative.");
            }
            entries.add(plain(RUNTIME + "stop-grace", grace, EngineSettings.DEFAULT_STOP_GRACE, stopGrace != null));
            if (maxStrays != null && maxStrays < 0) {
                throw new DatumConfigurationException(RUNTIME + "max-strays", RUNTIME + "max-strays is " + maxStrays
                    + "; it must be 0 (one per CPU, at least two) or more.");
            }
            int strays = maxStrays == null || maxStrays == 0 ? EngineSettings.defaultMaxStrays() : maxStrays;
            entries.add(plain(RUNTIME + "max-strays", strays, EngineSettings.defaultMaxStrays(), maxStrays != null && maxStrays != 0));
            Engine engine = new Engine(id, bytecode, grace, strays);

            boolean fast = failFast == null || failFast;
            entries.add(plain(RUNTIME + "fail-fast", fast, true, failFast != null));
            // Not safety clamps: a negative value is a typo, and quietly using 0 would skip the warm-up proof or cancel in-flight
            // runs at once, so the start stops naming the property.
            if (warmUpRuns != null && warmUpRuns < 0) {
                throw new DatumConfigurationException(RUNTIME + "warm-up-runs", RUNTIME + "warm-up-runs must be 0 or more, not " + warmUpRuns + ".");
            }
            int warm = warmUpRuns == null ? DEFAULT_WARM_UP_RUNS : warmUpRuns;
            entries.add(plain(RUNTIME + "warm-up-runs", warm, DEFAULT_WARM_UP_RUNS, warmUpRuns != null));
            Duration startup = startupBudget(entries);
            Duration shutdown = shutdownGrace == null ? DEFAULT_SHUTDOWN_GRACE : shutdownGrace;
            if (shutdown.isNegative()) {
                throw new DatumConfigurationException(RUNTIME + "shutdown-grace", RUNTIME + "shutdown-grace must not be negative, not " + shutdown + ".");
            }
            entries.add(plain(RUNTIME + "shutdown-grace", shutdown, DEFAULT_SHUTDOWN_GRACE, shutdownGrace != null));
            Lifecycle lifecycle = new Lifecycle(fast, warm, startup, shutdown);

            Run validationRun = validation.resolve(entries, RUNTIME + "validation.", false);
            Run pdfRun = pdf.resolve(entries, RUNTIME + "pdf.", true);

            entries.add(plain(RUNTIME + "programs.sandbox", sandboxProgram == null ? "packaged" : sandboxProgram.description(), "packaged",
                sandboxProgram != null));
            entries.add(plain(RUNTIME + "programs.pdf", pdfProgram == null ? "packaged" : pdfProgram.description(), "packaged", pdfProgram != null));
            Programs programs = new Programs(sandboxProgram, pdfProgram);

            Host host = new Host(formulaErrors, riskyPatterns, timeZone, unknownFields, logLevel);
            entries.add(plain(HOST + "formula-errors", host.formulaErrors(), "fail", isSet(formulaErrors)));
            entries.add(plain(HOST + "risky-patterns", host.riskyPatterns(), "refuse", isSet(riskyPatterns)));
            entries.add(plain(HOST + "time-zone", host.timeZone() == null ? "(the JVM's)" : host.timeZone(), "(the JVM's)", host.timeZone() != null));
            entries.add(plain(HOST + "unknown-fields", host.unknownFields(), "strip", isSet(unknownFields)));
            entries.add(plain(HOST + "log-level", host.logLevel(), "warn", isSet(logLevel)));

            Diagnostics diagnostics = diagnostics(entries);

            SettingsReport settingsReport = new SettingsReport(entries);
            for (String warning : settingsReport.warnings()) {
                warnings.accept(warning);
            }
            return new SandboxSettings(engine, lifecycle, validationRun, pdfRun, programs, host, diagnostics, settingsReport);
        }

        /**
         * {@code datum.runtime.diagnostics.*}. None of them is clamped: a trace word no mode has, a capture bound below 1 or a
         * directory that is not a path is a typo whose quiet replacement would keep personal data the operator did not mean
         * to keep, or drop what they meant to see, so the build stops naming the key. Whether the capture has its directory is
         * the sandbox's question ({@code DatumSandbox}): a host's own sink needs none.
         */
        private Diagnostics diagnostics(List<Entry> entries) {
            String traceKey = DIAGNOSTICS + "trace";
            TraceMode mode = isSet(trace) ? TraceMode.of(trace) : TraceMode.OFF;
            if (mode == null) {
                throw new DatumConfigurationException(traceKey, traceKey + " is '" + trace + "', which is not one of " + TraceMode.WORDS + ".",
                    "Set " + traceKey + " to one of " + TraceMode.WORDS + ", or leave it unset for off.");
            }
            entries.add(plain(traceKey, mode.word(), TraceMode.OFF.word(), isSet(trace)));
            boolean enabled = captureEnabled != null && captureEnabled;
            entries.add(plain(DIAGNOSTICS + "capture.enabled", enabled, false, captureEnabled != null));
            Path directory = null;
            if (isSet(captureDirectory)) {
                try {
                    directory = Path.of(captureDirectory).toAbsolutePath();
                } catch (InvalidPathException e) {
                    throw new DatumConfigurationException(DIAGNOSTICS + "capture.directory", DIAGNOSTICS + "capture.directory is not a path on this "
                        + "file system (" + e.getReason() + ").", e);
                }
            }
            entries.add(plain(DIAGNOSTICS + "capture.directory", directory == null ? "(none)" : directory.toString(), "(none)", directory != null));
            int runs = atLeastOne(DIAGNOSTICS + "capture.max-runs", captureMaxRuns, CaptureSettings.DEFAULT_MAX_RUNS).intValue();
            entries.add(plain(DIAGNOSTICS + "capture.max-runs", runs, CaptureSettings.DEFAULT_MAX_RUNS, captureMaxRuns != null));
            long bytes = atLeastOne(DIAGNOSTICS + "capture.max-bytes", captureMaxBytes, CaptureSettings.DEFAULT_MAX_BYTES).longValue();
            entries.add(plain(DIAGNOSTICS + "capture.max-bytes", bytes, CaptureSettings.DEFAULT_MAX_BYTES, captureMaxBytes != null));
            long queue = atLeastOne(DIAGNOSTICS + "capture.queue-bytes", captureQueueBytes, CaptureSettings.DEFAULT_QUEUE_BYTES).longValue();
            entries.add(plain(DIAGNOSTICS + "capture.queue-bytes", queue, CaptureSettings.DEFAULT_QUEUE_BYTES, captureQueueBytes != null));
            boolean logged = report == null || report;
            entries.add(plain(DIAGNOSTICS + "report", logged, true, report != null));
            return new Diagnostics(mode, new CaptureSettings(enabled, directory, runs, bytes, queue), logged);
        }

        private static Number atLeastOne(String key, @Nullable Number value, Number defaultValue) {
            if (value == null) {
                return defaultValue;
            }
            if (value.longValue() < 1) {
                throw new DatumConfigurationException(key, key + " is " + value + "; it must be 1 or more.");
            }
            return value;
        }

        private static boolean isSet(@Nullable String value) {
            return value != null && !value.isBlank();
        }

        /** {@code datum.runtime.startup-budget}: the default for none, whole seconds from 1 s to 5 min, a WARN when clamped. */
        private Duration startupBudget(List<Entry> entries) {
            String key = RUNTIME + "startup-budget";
            if (startupBudget == null) {
                entries.add(Entry.defaulted(key, DEFAULT_STARTUP_BUDGET));
                return DEFAULT_STARTUP_BUDGET;
            }
            Duration used = clampStartupBudget(startupBudget);
            if (used.equals(startupBudget)) {
                entries.add(plain(key, used, DEFAULT_STARTUP_BUDGET, true));
            } else {
                String range = "whole seconds from " + MIN_STARTUP_BUDGET.toSeconds() + " s to " + MAX_STARTUP_BUDGET.toSeconds() + " s";
                entries.add(Entry.clamped(key, used, startupBudget, range,
                    List.of(key + " = " + startupBudget + " is not " + range + "; using " + used.toSeconds() + " s.")));
            }
            return used;
        }
    }

    /** What one program's {@link Run} was set to. */
    private static final class RunValues {

        @Nullable Duration timeLimit;
        @Nullable Long memory;
        @Nullable Integer concurrency;
        @Nullable Duration wait;

        Run resolve(List<Entry> entries, String prefix, boolean pdfRun) {
            String name = pdfRun ? "pdf" : "validation";
            Bounds secondsBounds = pdfRun ? ProgramLimits.PDF_SECONDS : ProgramLimits.VALIDATION_SECONDS;
            Bounds memoryBounds = pdfRun ? ProgramLimits.PDF_MEMORY : ProgramLimits.VALIDATION_MEMORY;
            Bounds concurrencyBounds = pdfRun ? ProgramLimits.PDF_CONCURRENCY : ProgramLimits.VALIDATION_CONCURRENCY;

            long seconds = wholeSeconds(entries, prefix + "time-limit", timeLimit, name + "Seconds", secondsBounds);
            long bytes = bounded(entries, prefix + "memory", memory, name + "Memory", memoryBounds);

            // A concurrency of 0 or less is "the default": the ProgramLimits rule. Above the bound it is the bound, and a PDF
            // count says so in the words the slot count uses.
            Long askedSlots = concurrency == null ? null : concurrency.longValue();
            long slots = ProgramLimits.concurrency(askedSlots, concurrencyBounds);
            List<String> warnings = new ArrayList<>();
            if (askedSlots != null && askedSlots != slots) {
                warnings.add(ProgramLimits.clampWarning(name + "Concurrency", askedSlots, slots, concurrencyBounds));
                if (pdfRun && askedSlots > concurrencyBounds.max()) {
                    warnings.add(prefix + "concurrency = " + askedSlots + " is above " + concurrencyBounds.max() + "; using " + slots + ".");
                }
            }
            String key = prefix + "concurrency";
            if (askedSlots == null) {
                entries.add(Entry.defaulted(key, (int) slots));
            } else if (!warnings.isEmpty()) {
                entries.add(Entry.clamped(key, (int) slots, askedSlots, "[" + concurrencyBounds.min() + ", " + concurrencyBounds.max() + "]", warnings));
            } else {
                entries.add(plain(key, (int) slots, 0, true));
            }

            Duration waited = waitOf(entries, prefix + "wait", name, pdfRun);
            return new Run(Duration.ofSeconds(seconds), bytes, (int) slots, waited);
        }

        /** A time budget in whole seconds; a fraction is dropped with a WARN so 2500ms is never silently 2 s, then the bounds. */
        private static long wholeSeconds(List<Entry> entries, String key, @Nullable Duration asked, String limitName, Bounds bounds) {
            Duration defaultValue = Duration.ofSeconds(bounds.defaultValue());
            if (asked == null) {
                entries.add(Entry.defaulted(key, defaultValue));
                return bounds.defaultValue();
            }
            List<String> warnings = new ArrayList<>();
            long whole = asked.toSeconds();
            if (asked.toNanosPart() != 0) {
                warnings.add(key + " = " + asked + " is not whole seconds; using " + whole + " s.");
            }
            long used = ProgramLimits.clamp(whole, bounds);
            if (used != whole) {
                warnings.add(ProgramLimits.clampWarning(limitName, whole, used, bounds));
            }
            if (used != whole || asked.toNanosPart() != 0) {
                entries.add(Entry.clamped(key, Duration.ofSeconds(used), asked, "whole seconds in [" + bounds.min() + ", " + bounds.max() + "]", warnings));
            } else {
                entries.add(plain(key, Duration.ofSeconds(used), defaultValue, true));
            }
            return used;
        }

        private static long bounded(List<Entry> entries, String key, @Nullable Long asked, String limitName, Bounds bounds) {
            long used = ProgramLimits.clamp(asked, bounds);
            if (asked == null) {
                entries.add(Entry.defaulted(key, used));
            } else if (asked == used) {
                entries.add(plain(key, used, bounds.defaultValue(), true));
            } else {
                entries.add(Entry.clamped(key, used, asked, "[" + bounds.min() + ", " + bounds.max() + "] bytes",
                    List.of(ProgramLimits.clampWarning(limitName, asked, used, bounds))));
            }
            return used;
        }

        /** The slot wait. A validation wait goes through whole seconds then the bounds; a PDF wait through one rule and one text. */
        private Duration waitOf(List<Entry> entries, String key, String name, boolean pdfRun) {
            Bounds bounds = ProgramLimits.VALIDATION_WAIT;
            Duration defaultWait = Duration.ofSeconds(bounds.defaultValue());
            if (wait == null) {
                entries.add(Entry.defaulted(key, defaultWait));
                return defaultWait;
            }
            if (pdfRun) {
                Duration whole = Duration.ofSeconds(Math.max(0, wait.toSeconds()));
                if (whole.compareTo(MAX_WAIT) > 0) {
                    whole = MAX_WAIT;
                }
                entries.add(whole.equals(wait) ? plain(key, whole, defaultWait, true)
                    : Entry.clamped(key, whole, wait, "whole seconds from 0 to 10", List.of(key + " = " + wait
                        + " is not whole seconds from 0 to 10; using " + whole.toSeconds() + " s.")));
                return whole;
            }
            List<String> warnings = new ArrayList<>();
            long whole = wait.toSeconds();
            if (wait.toNanosPart() != 0) {
                warnings.add(key + " = " + wait + " is not whole seconds; using " + whole + " s.");
            }
            long used = ProgramLimits.waitSeconds(whole);
            if (used != whole) {
                warnings.add(ProgramLimits.clampWarning(name + "Wait", whole, used, bounds));
            }
            if (used != whole || wait.toNanosPart() != 0) {
                entries.add(Entry.clamped(key, Duration.ofSeconds(used), wait, "whole seconds in [0, 10]", warnings));
            } else {
                entries.add(plain(key, Duration.ofSeconds(used), defaultWait, true));
            }
            return Duration.ofSeconds(used);
        }
    }

    /** An entry for a value that needed no clamp: the default when nothing was set or it equals the default, else configured. */
    private static Entry plain(String key, Object value, Object defaultValue, boolean set) {
        return !set || Objects.equals(value, defaultValue) ? Entry.defaulted(key, value) : Entry.configured(key, value);
    }

    // ------------------------------------------------------------------------------------------------ rules

    /** An engine id as the engines are selected by it: trimmed, in lower case ({@link Locale#ROOT}). */
    static String engineId(String id) {
        return id.trim().toLowerCase(Locale.ROOT);
    }

    /** Null is the default; whole seconds from 1 s to 5 min otherwise (the time budget of a run is whole seconds). */
    public static Duration clampStartupBudget(@Nullable Duration configured) {
        if (configured == null) {
            return DEFAULT_STARTUP_BUDGET;
        }
        Duration whole = Duration.ofSeconds(configured.toSeconds());
        if (whole.compareTo(MIN_STARTUP_BUDGET) < 0) {
            return MIN_STARTUP_BUDGET;
        }
        return whole.compareTo(MAX_STARTUP_BUDGET) > 0 ? MAX_STARTUP_BUDGET : whole;
    }

    private static String word(String property, @Nullable String value, List<String> allowed, String fallback) {
        if (value == null || value.isEmpty()) {
            return fallback;
        }
        if (allowed.contains(value)) {
            return value;
        }
        throw new DatumConfigurationException(property, property + " is '" + value + "', which is not one of " + allowed + ".",
            "Set " + property + " to one of " + allowed + ", or leave it unset for the default.");
    }

    private static @Nullable String zone(@Nullable String value) {
        if (value == null || value.isBlank()) {
            return null;
        }
        try {
            ZoneId.of(value);
            return value;
        } catch (DateTimeException e) {
            throw new DatumConfigurationException(HOST + "time-zone", HOST + "time-zone is '" + value + "', which is not a time zone id.", e);
        }
    }
}
