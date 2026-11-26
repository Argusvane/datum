package com.argusvane.datum.sandbox.spring;

import com.argusvane.datum.sandbox.runtime.SandboxSettings;
import com.argusvane.datum.sandbox.wasi.EngineSettings;
import com.argusvane.datum.springweb.spring.SpringResources;
import java.time.Duration;
import java.util.Locale;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.core.io.Resource;
import org.springframework.util.unit.DataSize;

/**
 * {@code datum.runtime.*}: which engine runs the programs, how the runtime starts and stops, and the budgets
 * and slots of the two programs. The budgets, the slots and the validation
 * wait are clamped to their documented safety bounds through {@code ProgramLimits} (a value used other than as set is logged
 * once at WARN).
 *
 * <p>{@code datum.runtime.output.*} (stdout 32 MiB, stderr 64 KiB,
 * outcome 8 MiB) is not offered. Those caps are datum-core's constants ({@code Budget.STDOUT_LIMIT} and {@code STDERR_LIMIT}, and the TypeScript hosts' {@code maxResultLength}), which no budget reads from
 * configuration; a property that changed nothing would mislead.
 *
 * <p>The Spring binding of {@link SandboxSettings}: the clamping is the settings', and
 * {@link #toSettings()} is what the library reads. The defaults stay literals here so the configuration metadata
 * names them; a test holds them equal to {@link SandboxSettings#defaults()}. {@code datum.runtime.verify-max-bytes} is the PDF
 * verify route's cap and is bound by the PDF binding, under the same key.
 */
@ConfigurationProperties(prefix = "datum.runtime")
public class DatumSandboxProperties {

    /**
     * The engine that runs QuickJS, by the id of its {@code GuestRuntimeProvider} on the class path: {@code endive} (the
     * default, in-process, the only engine). An id no engine has, or one unavailable here, stops the start naming the
     * engines found; an application's own {@code GuestRuntime} bean is used instead and this is then not read.
     */
    private String engine = "endive";

    /**
     * Whether a runtime that cannot prove its programs at startup stops the application context. When false the
     * application starts, health reports DOWN with the reason and every run answers 503 until a recheck passes.
     */
    private boolean failFast = true;

    /**
     * Whether the application may start when the engine would run the programs as JVM bytecode (no native code for this
     * platform, or no native runner it can use): validation then runs several times slower and the PDF routes answer 503.
     * False refuses the start, naming the platform and the fix, whatever fail-fast says.
     */
    private boolean allowBytecode = false;

    /** How many smoke runs warm the runtime up at startup (0: none). */
    private int warmUpRuns = 3;

    /** How long a shutdown waits for runs in flight before cancelling them. */
    private Duration shutdownGrace = Duration.ofSeconds(10);

    /**
     * The wall-time budget of the proof runs at startup and recheck: the ABI probes, the smoke run and the
     * warm-up runs. A run gets the longer of this and its own per-run budget; requests keep the per-run budgets.
     * Whole seconds from 1 s to 5 min (outside that it is clamped with a WARN).
     */
    private Duration startupBudget = Duration.ofSeconds(30);

    /**
     * How long a run that was stopped (at its time budget, or by a shutdown) is given to end and close its instance before its
     * output is read as it stands. Raise it on a slow host or an engine with slow set-up. Not negative.
     */
    private Duration stopGrace = EngineSettings.DEFAULT_STOP_GRACE;

    /**
     * How many stopped runs may outlive their grace before new runs are refused (a stopped run's caller is answered, so the
     * slots do not bound it). 0 is the default: one per CPU the JVM may use, at least two.
     */
    private int maxStrays = 0;

    private final Validation validation = new Validation();

    private final Pdf pdf = new Pdf();

    private final Programs programs = new Programs();

    private final Diagnostics diagnostics = new Diagnostics();

    public String getEngine() {
        return engine;
    }

    public void setEngine(String engine) {
        this.engine = engine;
    }

    public boolean isFailFast() {
        return failFast;
    }

    public void setFailFast(boolean failFast) {
        this.failFast = failFast;
    }

    public boolean isAllowBytecode() {
        return allowBytecode;
    }

    public void setAllowBytecode(boolean allowBytecode) {
        this.allowBytecode = allowBytecode;
    }

    public int getWarmUpRuns() {
        return warmUpRuns;
    }

    public void setWarmUpRuns(int warmUpRuns) {
        this.warmUpRuns = warmUpRuns;
    }

    public Duration getShutdownGrace() {
        return shutdownGrace;
    }

    public void setShutdownGrace(Duration shutdownGrace) {
        this.shutdownGrace = shutdownGrace;
    }

    public Duration getStartupBudget() {
        return startupBudget;
    }

    public void setStartupBudget(Duration startupBudget) {
        this.startupBudget = startupBudget;
    }

    public Duration getStopGrace() {
        return stopGrace;
    }

    public void setStopGrace(Duration stopGrace) {
        this.stopGrace = stopGrace;
    }

    public int getMaxStrays() {
        return maxStrays;
    }

    public void setMaxStrays(int maxStrays) {
        this.maxStrays = maxStrays;
    }

    public Validation getValidation() {
        return validation;
    }

    public Pdf getPdf() {
        return pdf;
    }

    public Programs getPrograms() {
        return programs;
    }

    public Diagnostics getDiagnostics() {
        return diagnostics;
    }

    /** These properties as the settings builder, the program overrides as resource handles; the settings clamp what they are given. */
    public SandboxSettings.Builder toBuilder() {
        return SandboxSettings.builder()
            .engine(engine).allowBytecode(allowBytecode).stopGrace(stopGrace).maxStrays(maxStrays)
            .failFast(failFast).warmUpRuns(warmUpRuns).startupBudget(startupBudget).shutdownGrace(shutdownGrace)
            .validationTimeLimit(validation.getTimeLimit()).validationMemory(bytes(validation.getMemory()))
            .validationConcurrency(validation.getConcurrency()).validationWait(validation.getWait())
            .pdfTimeLimit(pdf.getTimeLimit()).pdfMemory(bytes(pdf.getMemory())).pdfConcurrency(pdf.getConcurrency()).pdfWait(pdf.getWait())
            .sandboxProgram(SpringResources.handle(programs.getSandbox())).pdfProgram(SpringResources.handle(programs.getPdf()))
            .trace(diagnostics.getTrace() == null ? null : diagnostics.getTrace().name().toLowerCase(Locale.ROOT))
            .report(diagnostics.isReport())
            .captureEnabled(diagnostics.getCapture().isEnabled()).captureDirectory(diagnostics.getCapture().getDirectory())
            .captureMaxRuns(diagnostics.getCapture().getMaxRuns()).captureMaxBytes(bytes(diagnostics.getCapture().getMaxBytes()))
            .captureQueueBytes(bytes(diagnostics.getCapture().getQueueBytes()));
    }

    /** These properties as the library's settings, with the host's keys at their defaults. */
    public SandboxSettings toSettings() {
        return toBuilder().build();
    }

    /** These properties and the {@code datum.host.*} ones as the library's settings: the one value the sandbox runs with. */
    public SandboxSettings toSettings(DatumHostProperties host) {
        return host.applyTo(toBuilder()).build();
    }

    private static Long bytes(DataSize size) {
        return size == null ? null : size.toBytes();
    }

    /** {@code datum.runtime.validation.*}: one validation run (the sandbox program). */
    public static class Validation {

        /** The wall time one validation may take, whole seconds, 1 to 60. */
        private Duration timeLimit = Duration.ofSeconds(5);

        /** The linear memory one validation may use, 4 MB to 1 GB. */
        private DataSize memory = DataSize.ofMegabytes(32);

        /** Validation runs at once, up to 64; 0 is one per CPU. */
        private int concurrency = 0;

        /** How long a run waits for a free slot before 503 server.busy, whole seconds, 0 to 10 (0 refuses at once). */
        private Duration wait = Duration.ofSeconds(2);

        public Duration getTimeLimit() {
            return timeLimit;
        }

        public void setTimeLimit(Duration timeLimit) {
            this.timeLimit = timeLimit;
        }

        public DataSize getMemory() {
            return memory;
        }

        public void setMemory(DataSize memory) {
            this.memory = memory;
        }

        public int getConcurrency() {
            return concurrency;
        }

        public void setConcurrency(int concurrency) {
            this.concurrency = concurrency;
        }

        public Duration getWait() {
            return wait;
        }

        public void setWait(Duration wait) {
            this.wait = wait;
        }
    }

    /** {@code datum.runtime.pdf.*}: one PDF run (the PDF program). */
    public static class Pdf {

        /** The wall time one PDF run may take, whole seconds, 1 to 300. */
        private Duration timeLimit = Duration.ofSeconds(15);

        /** The linear memory one PDF run may use, 32 MB to 4 GB. */
        private DataSize memory = DataSize.ofMegabytes(256);

        /** PDF runs at once, up to 64; 0 is min(2, CPUs). */
        private int concurrency = 0;

        /** How long a PDF run waits for a free slot before 503 server.busy, whole seconds, 0 to 10. */
        private Duration wait = Duration.ofSeconds(2);

        public Duration getTimeLimit() {
            return timeLimit;
        }

        public void setTimeLimit(Duration timeLimit) {
            this.timeLimit = timeLimit;
        }

        public DataSize getMemory() {
            return memory;
        }

        public void setMemory(DataSize memory) {
            this.memory = memory;
        }

        public int getConcurrency() {
            return concurrency;
        }

        public void setConcurrency(int concurrency) {
            this.concurrency = concurrency;
        }

        public Duration getWait() {
            return wait;
        }

        public void setWait(Duration wait) {
            this.wait = wait;
        }
    }

    /**
     * {@code datum.runtime.diagnostics.*}: what the sandbox tells an operator about its runs. The run trace and the failed-run
     * capture are off by default; the startup settings report is on.
     */
    public static class Diagnostics {

        /** Which runs get one trace line at INFO on the logger datum.sandbox.trace: off, failures or all. It never holds answers. */
        private Trace trace = Trace.OFF;

        /**
         * Whether the effective settings (every value and where it came from, the engine, the programs' sha256 and ABI) are
         * logged once at start, at INFO on the logger datum.sandbox.settings.
         */
        private boolean report = true;

        private final Capture capture = new Capture();

        public Trace getTrace() {
            return trace;
        }

        public void setTrace(Trace trace) {
            this.trace = trace;
        }

        public boolean isReport() {
            return report;
        }

        public void setReport(boolean report) {
            this.report = report;
        }

        public Capture getCapture() {
            return capture;
        }
    }

    /** Which runs the run trace writes a line for. */
    public enum Trace {
        /** None (the default). */
        OFF,
        /** Only runs that failed: a trap, an output cap, a time or memory budget, a stop, an unavailable runtime, an answer the protocol could not take. A program's own refusal is not a failed run. */
        FAILURES,
        /** Every run, the start-up proofs and warm-ups included. */
        ALL
    }

    /**
     * {@code datum.runtime.diagnostics.capture.*}: failed runs kept whole for debugging. A capture holds the submitted answers and
     * the form definition (personal data) in clear text; turn it off after debugging.
     */
    public static class Capture {

        /**
         * Whether failed runs are written to the capture directory (stdin, stdout, stderr, run.js and meta.json per run). A capture
         * holds the submitted answers and the form definition (personal data) in clear text: turn it off after debugging.
         */
        private boolean enabled = false;

        /**
         * Where captures go, required when enabled: created mode 700 if missing; refused at start unless it is a real directory
         * (not a link) owned by the JVM's user with no group or other permission, on a POSIX file system, and on macOS with no
         * access control list (ls -lde lists none; one inherited from the parent counts, so remove the parent's too with chmod -N).
         * Checked again before every write.
         */
        private String directory;

        /** The most captures kept; the oldest are removed first. */
        private int maxRuns = 20;

        /** The most bytes all kept captures take together; a single capture larger than this is dropped. */
        private DataSize maxBytes = DataSize.ofMegabytes(64);

        /** The most bytes of captures waiting to be written; a capture that does not fit is dropped (runs never wait for it). */
        private DataSize queueBytes = DataSize.ofMegabytes(64);

        public boolean isEnabled() {
            return enabled;
        }

        public void setEnabled(boolean enabled) {
            this.enabled = enabled;
        }

        public String getDirectory() {
            return directory;
        }

        public void setDirectory(String directory) {
            this.directory = directory;
        }

        public int getMaxRuns() {
            return maxRuns;
        }

        public void setMaxRuns(int maxRuns) {
            this.maxRuns = maxRuns;
        }

        public DataSize getMaxBytes() {
            return maxBytes;
        }

        public void setMaxBytes(DataSize maxBytes) {
            this.maxBytes = maxBytes;
        }

        public DataSize getQueueBytes() {
            return queueBytes;
        }

        public void setQueueBytes(DataSize queueBytes) {
            this.queueBytes = queueBytes;
        }
    }

    /**
     * {@code datum.runtime.programs.*}: program files used instead of datum-programs' (a {@code file:} or
     * {@code classpath:} resource). An override is still proved by the ABI probe; it is read again by the
     * actuator's recheck.
     */
    public static class Programs {

        /** The sandbox program ({@code datum-sandbox-program.js}) to run instead of the packaged one. */
        private Resource sandbox;

        /** The PDF program ({@code datum-pdf-program.js}) to run instead of the packaged one. */
        private Resource pdf;

        public Resource getSandbox() {
            return sandbox;
        }

        public void setSandbox(Resource sandbox) {
            this.sandbox = sandbox;
        }

        public Resource getPdf() {
            return pdf;
        }

        public void setPdf(Resource pdf) {
            this.pdf = pdf;
        }
    }
}
