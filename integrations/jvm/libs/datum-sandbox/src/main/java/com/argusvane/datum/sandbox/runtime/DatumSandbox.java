package com.argusvane.datum.sandbox.runtime;

import com.argusvane.datum.core.DatumConfigurationException;
import com.argusvane.datum.core.DatumEventPublisher;
import com.argusvane.datum.core.ProgramUnavailableException;
import com.argusvane.datum.sandbox.diagnostics.CaptureSettings;
import com.argusvane.datum.sandbox.diagnostics.DirectoryCaptureSink;
import com.argusvane.datum.sandbox.diagnostics.FailedRunCapture;
import com.argusvane.datum.sandbox.diagnostics.Guarded;
import com.argusvane.datum.sandbox.diagnostics.RunCapture;
import com.argusvane.datum.sandbox.diagnostics.RunCaptureSink;
import com.argusvane.datum.sandbox.diagnostics.RunFacts;
import com.argusvane.datum.sandbox.diagnostics.RunRecorder;
import com.argusvane.datum.sandbox.diagnostics.RunTrace;
import com.argusvane.datum.sandbox.diagnostics.SandboxReport;
import com.argusvane.datum.sandbox.diagnostics.TraceMode;
import com.argusvane.datum.sandbox.diagnostics.TraceRecord;
import com.argusvane.datum.sandbox.wasi.EngineInfo;
import com.argusvane.datum.core.observation.DatumObservations;
import com.argusvane.datum.sandbox.diagnostics.SettingsReport;
import com.argusvane.datum.sandbox.diagnostics.SettingsReport.Entry;
import com.argusvane.datum.sandbox.wasi.EngineSettings;
import com.argusvane.datum.sandbox.wasi.RunTimings;
import com.argusvane.datum.sandbox.observation.GuestRunObservations;
import com.argusvane.datum.sandbox.protocol.AbiProbe;
import com.argusvane.datum.sandbox.wasi.Budget;
import com.argusvane.datum.sandbox.protocol.HostOptions;
import com.argusvane.datum.sandbox.protocol.PdfKernel;
import com.argusvane.datum.sandbox.protocol.PdfKernelDecorator;
import com.argusvane.datum.sandbox.protocol.PdfProgram;
import com.argusvane.datum.sandbox.protocol.Program;
import com.argusvane.datum.sandbox.protocol.ProgramLimits;
import com.argusvane.datum.sandbox.protocol.ProgramRunner;
import com.argusvane.datum.sandbox.wasi.GuestRuntime;
import com.argusvane.datum.sandbox.protocol.RunLog;
import com.argusvane.datum.sandbox.wasi.RunOutput;
import com.argusvane.datum.sandbox.protocol.RunScript;
import com.argusvane.datum.sandbox.protocol.RunSlots;
import com.argusvane.datum.sandbox.protocol.Sandbox;
import com.argusvane.datum.sandbox.protocol.SandboxDecorator;
import com.argusvane.datum.sandbox.protocol.SandboxException;
import com.argusvane.datum.sandbox.protocol.SandboxService;
import com.argusvane.datum.sandbox.wasi.Termination;
import com.argusvane.datum.sandbox.events.SandboxReadyEvent;
import com.argusvane.datum.sandbox.events.SandboxRunInterruptedEvent;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.Callable;
import java.util.concurrent.CancellationException;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Future;
import java.util.concurrent.FutureTask;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.SynchronousQueue;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;
import java.util.function.Supplier;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The programs' runtime as the application runs it: one {@link GuestRuntime} (the engine a binding selected, Endive
 * by default, or the application's own), the two programs, their slots, the ABI gate, the warm-up and the shutdown.
 * What the engine is and its mode are its {@link EngineInfo}, read through {@link GuestRuntime#engineInfo()}, never by
 * reflection on the runtime's class; whether the PDF program can run on it is this runtime's decision from that mode
 * ({@link ProgramRunner#canRunPdf(EngineInfo)}: not on bytecode). Every run goes to the engine through the protocol's
 * {@link ProgramRunner#on(GuestRuntime)}, which builds the guest run and answers a run that cannot start as 503.
 *
 * <p>Start ({@link #start()}): first, an engine that runs the programs as JVM bytecode ({@link EngineInfo#isBytecode()})
 * stops the start with {@code EngineBytecodeException} unless {@code datum.runtime.allow-bytecode} is true, whatever
 * {@code datum.runtime.fail-fast} says; then the programs are read ({@link ProgramStore}); the sandbox program is proved for
 * {@code SandboxAbi.MIN} and the PDF program for {@code PdfAbi.MIN} (the ABI gates), so
 * a stale program file is refused before any submission is judged by it; the runtime
 * is warmed up with {@code datum.runtime.warm-up-runs} smoke runs, each of which must give the expected verdict
 * (an engine warns about its own platform facts itself: Endive about the Panama runner's native access); then
 * {@link SandboxReadyEvent}. A failure stops the context when {@code datum.runtime.fail-fast} (the
 * default); otherwise the runtime is DOWN with the reason, health says so and every run answers 503
 * {@code server.unavailable} until {@link #recheck()} passes. The PDF program is not needed for submissions: a
 * missing one, or one the engine cannot run here ({@link ProgramRunner#canRunPdf(EngineInfo)} false: Endive's bytecode fallback),
 * leaves the PDF path unavailable with a WARN; a present
 * PDF program that does not answer for the floor is a stale asset and fails like the sandbox program.
 *
 * <p>Runs: every run of either program goes through this runtime's own thread pool and is counted in flight.
 * Validation takes a validation slot ({@code SandboxService}); PDF runs take a {@link #pdfSlots()} slot
 * (datum-pdf). A slot not free within the wait refuses the run with 503 {@code server.busy}. A run stopped by a
 * limit publishes {@link SandboxRunInterruptedEvent}. A run still going {@link #BACKSTOP_SECONDS} past its own
 * budget (a runtime that does not enforce it) is cancelled and waited for up to {@link #STOP_GRACE}; its caller is
 * answered as a budget stop (503 {@code wasm.execution_error}, {@link Termination#BUDGET}, or {@link Termination#STUCK}
 * when its thread still does not end). A stuck one counts as stuck, and while there are as many stuck runs as validation and PDF slots
 * together every new run is refused with 503 {@code server.unavailable}: a runtime that could not stop its
 * guests is a fault, not a queue to wait in ({@code server.busy} is for slot exhaustion within the wait). The
 * slots keep bounding the guests alive even when their callers have been answered; {@link #stuckRuns()} and the
 * runtime's own {@code strayRuns()} are on health and the {@code datum} endpoint.
 *
 * <p>Stop ({@link #stop()}): no new run starts (it answers 503 {@code server.unavailable}), runs in flight get
 * {@code datum.runtime.shutdown-grace} to finish, the rest are cancelled (their requests answer 503), the
 * pool is shut down (waited for up to 5 s), and the failed-run capture drains in what is left of the same grace, then drops
 * the rest (counted): one deadline, so a stop never takes longer than the grace plus the pool's 5 s.
 *
 * <p>Diagnostics ({@code datum.runtime.diagnostics.*}): at start, before anything is proved, the
 * effective-settings report ({@link #report()}) goes to the logger {@value SandboxReport#LOGGER} at INFO; the failed-run capture
 * is opened (a capture directory the JVM's user alone cannot hold refuses the start, whatever fail-fast says); then every run
 * the protocol judges is traced ({@link RunTrace}, {@code off} by default) and, when it failed, captured
 * ({@link FailedRunCapture}): the run's facts and its slot wait are taken while it holds its slot, the trace and the capture
 * are made on the same thread once the slot is released ({@link RunSlots#afterRelease}), so a slow trace sink holds no slot.
 * With the trace off and the capture off nothing in the run path is measured, formatted or allocated for them. {@link #explain()} is what the sandbox actually runs with: the settings, with the inputs the
 * application supplied in their place shown as {@code REPLACED} and the slot counts resolved.
 *
 * <p>A plain class (integrations/jvm/README.md "Libraries and bindings"): {@link #start()},
 * {@link #stop()}, {@link #recheck()} and {@link #status()} are what every host binding calls. The Spring binding
 * wraps it in a {@code SmartLifecycle} ({@code DatumSandboxLifecycle}) whose phase sits below the web server's
 * lifecycles, so the programs are proved before the server takes its first request and the runtime stops after the
 * server has stopped taking them; a Quarkus binding would call the same four methods from its startup and shutdown
 * observers.
 */
public final class DatumSandbox implements AutoCloseable {

    private static final Logger LOG = LoggerFactory.getLogger(DatumSandbox.class);

    /**
     * How long past its own time budget a run is waited for before it is cancelled anyway: a backstop for a
     * runtime that does not enforce its budget (Endive stops a run at the budget, plus its 5 s stop grace).
     */
    static final long BACKSTOP_SECONDS = 30;

    /** How long a cancelled run's thread is waited for before it counts as stuck (Endive's own stop grace). */
    static final Duration STOP_GRACE = Duration.ofSeconds(5);

    /** The mode {@link #engineInfo()} reports when there is no engine at all: it runs nothing, the PDF program included. */
    public static final String NO_ENGINE = "none";

    /** The property of {@link SandboxSettings.Engine#allowBytecode()}, which the refusal names. */
    public static final String ALLOW_BYTECODE = SandboxSettings.ALLOW_BYTECODE;

    /** The loader the engine is looked up in and the programs are read from unless the builder names one. */
    private static ClassLoader defaultLoader() {
        ClassLoader context = Thread.currentThread().getContextClassLoader();
        return context != null ? context : DatumSandbox.class.getClassLoader();
    }

    private static final AtomicInteger POOLS = new AtomicInteger();

    /**
     * The proof runs of this thread get the startup budget: prove() runs on the starting (or rechecking) thread and
     * the sandbox service calls the guarded runtime on that same thread, so the widening reaches exactly those runs
     * and never a request's.
     */
    private final ThreadLocal<Integer> proofSeconds = new ThreadLocal<>();

    /** A tracked run's phases: not started, in the delegate, done, cancelled before it started, abandoned while in it. */
    private static final int NEW = 0;
    private static final int RUNNING = 1;
    private static final int ENDED = 2;
    private static final int DROPPED = 3;
    private static final int STUCK = 4;

    private final GuestRuntime delegate;
    /** Whether this sandbox made the runtime itself (the builder's selection), so it closes it with itself. */
    private final boolean ownsRuntime;
    /** Set by the first {@link #close()}: the engine is closed once, however often the sandbox is. */
    private final AtomicBoolean closed = new AtomicBoolean();
    /** The delegate as the protocol runs it ({@link ProgramRunner#on}), or null when there is no delegate. */
    private final ProgramRunner engineRunner;
    private final ProgramStore store;
    private final ProgramLimits limits;
    private final HostOptions hostOptions;
    private final SandboxSettings settings;
    private final DatumEventPublisher events;
    private final RunLog runLog;
    private final Supplier<AbiProbe> probes;
    /** Datum's own observation first, then the host's decorators in their order. */
    private final SandboxDecorator sandboxes;
    private final PdfKernelDecorator pdfKernels;
    private final RunSlots validationSlots;
    private final RunSlots pdfSlots;
    private final ThreadPoolExecutor pool;
    private final Set<Future<RunOutput>> inFlight = ConcurrentHashMap.newKeySet();
    private final ProgramRunner guarded = new GuardedRuntime();
    private final Object lock = new Object();
    private final EngineInfo engine;
    /** Whether the PDF program can run on this engine: {@link ProgramRunner#canRunPdf(GuestRuntime)}, and false with no engine at all (a null delegate). */
    private final boolean pdfRunnable;
    /** Runs cancelled past the backstop whose threads have not ended yet. */
    private final AtomicInteger stuck = new AtomicInteger();
    /** As many stuck runs as there are slots refuse new runs: the slots' bound on live guests holds. */
    private final int stuckLimit;
    private volatile Duration backstop = Duration.ofSeconds(BACKSTOP_SECONDS);
    private volatile Duration stopGrace = STOP_GRACE;

    private volatile RunObserver observer;
    private volatile boolean accepting;
    private volatile boolean running;
    private volatile SandboxStatus.State state = SandboxStatus.State.STARTING;
    private volatile String reason = "The Datum runtime has not started yet.";
    private volatile Sandbox sandbox;
    /** The gate of the last proof, to notice a supplier that hands the same one back (see {@link #prove()}). */
    private volatile AbiProbe lastProbe;
    private volatile boolean sharedProbeWarned;
    private volatile PdfKernel pdf;
    private volatile ProgramStore.Programs programs;
    private volatile String pdfUnavailable;
    private volatile long warmUpMillis;

    /** What the runtime was made with, when known: the settings' for an owned engine, the binding's for its own, else null. */
    private final @Nullable EngineSettings engineSettings;
    private final RunTrace runTrace;
    private final Consumer<String> reportLog;
    /** The clock a capture's name is stamped from (the builder's, UTC by default). */
    private final Clock clock;
    /** The failed-run capture, when enabled. */
    private final @Nullable FailedRunCapture capture;
    /**
     * Whether the trace or the capture is on: each proof then hands its services a {@link Recorder} of the programs it loaded;
     * otherwise they hold none and nothing is done per run.
     */
    private final boolean watched;

    private static final SecureRandom RUN_IDS = new SecureRandom();

    /**
     * A builder over the defaults: the default host options, the standard ABI gate, no decorators, no observations.
     */
    public static Builder builder() {
        return new Builder();
    }

    /**
     * Builds a {@link DatumSandbox}: every input but the settings has a default, so a host
     * with no framework writes {@code DatumSandbox.builder().build()}. With no {@link #runtime(GuestRuntime)} the engine is
     * selected by {@code settings.engine().id()} through {@code GuestRuntimes} and made for the settings' limits, and the
     * sandbox owns it and closes it with itself; the programs are datum-programs' unless the settings name overrides; the
     * limits and the host options are the settings' unless given. The event publisher, observations, run log, ABI gate and
     * decorators are optional. A binding that has beans for these hands them over.
     */
    public static final class Builder {

        private SandboxSettings settings = SandboxSettings.defaults();
        private GuestRuntime runtime;
        private boolean noRuntime;
        private ClassLoader loader;
        private Clock clock = Clock.systemUTC();
        private ProgramStore store;
        private ProgramLimits limits;
        private HostOptions hostOptions;
        private DatumEventPublisher events = DatumEventPublisher.noop();
        private RunLog runLog = RunLog.slf4j();
        private Supplier<AbiProbe> probes;
        private List<? extends SandboxDecorator> sandboxDecorators = List.of();
        private List<? extends PdfKernelDecorator> pdfKernelDecorators = List.of();
        private DatumObservations observations = DatumObservations.none();
        private @Nullable EngineSettings engineSettings;
        private RunTrace runTrace = RunTrace.log();
        private @Nullable RunCaptureSink captureSink;
        private @Nullable Consumer<String> reportLog;

        private Builder() {
        }

        /** How the sandbox runs; {@link SandboxSettings#defaults()} when not given. */
        public Builder settings(SandboxSettings value) { this.settings = Objects.requireNonNull(value, "settings"); return this; }

        /**
         * The runtime that runs QuickJS, instead of selecting one by id; the caller keeps ownership and closes it. It is the
         * application's own: the report shows the engine and its stop grace and stray bound as {@code REPLACED}, since nothing says it was made from the settings.
         */
        public Builder runtime(GuestRuntime value) {
            this.runtime = Objects.requireNonNull(value, "runtime");
            this.noRuntime = false;
            this.engineSettings = null;
            return this;
        }

        /**
         * A runtime a binding selected and made itself, with the engine settings it was made with: the report compares them with
         * the settings and shows only what differs as {@code REPLACED} (an application's own {@code EngineSettings}, or a
         * runtime whose id is not the configured one). The caller keeps ownership.
         */
        public Builder runtime(GuestRuntime value, EngineSettings madeWith) {
            runtime(value);
            this.engineSettings = Objects.requireNonNull(madeWith, "madeWith");
            return this;
        }

        /** No runtime at all: the sandbox stays DOWN, every run answers 503 (what health shows for a missing engine). */
        public Builder withoutRuntime() { this.runtime = null; this.noRuntime = true; return this; }

        /** The class loader the engine is looked up in and the packaged programs are read from; the context loader by default. */
        public Builder classLoader(ClassLoader value) { this.loader = Objects.requireNonNull(value, "classLoader"); return this; }

        /** The clock {@code today()} reads and the PDF failure memory uses; UTC by default. */
        public Builder clock(Clock value) { this.clock = Objects.requireNonNull(value, "clock"); return this; }

        /** Where the programs come from, instead of the settings' overrides over datum-programs. */
        public Builder store(ProgramStore value) { this.store = Objects.requireNonNull(value, "store"); return this; }

        /** The budgets, slots and wait, instead of the settings' own. */
        public Builder limits(ProgramLimits value) { this.limits = Objects.requireNonNull(value, "limits"); return this; }

        /** The host's context keys, instead of the settings'. */
        public Builder hostOptions(HostOptions value) { this.hostOptions = Objects.requireNonNull(value, "hostOptions"); return this; }

        /** Where the ready and interrupted events go, used as given (the host guards its default publisher); none by default. */
        public Builder events(DatumEventPublisher value) { this.events = Objects.requireNonNull(value, "events"); return this; }

        /** Where a real validation's run log goes; the SLF4J logger by default. */
        public Builder runLog(RunLog value) { this.runLog = Objects.requireNonNull(value, "runLog"); return this; }

        /** A fresh ABI gate per proof (start and every recheck); on the builder's clock by default. */
        public Builder probes(Supplier<AbiProbe> value) { this.probes = Objects.requireNonNull(value, "probes"); return this; }

        /** Wrap the sandbox, the first innermost ({@link SandboxDecorator#compose}). */
        public Builder sandboxDecorators(List<? extends SandboxDecorator> value) { this.sandboxDecorators = Objects.requireNonNull(value, "sandboxDecorators"); return this; }

        /** Wrap the PDF program likewise ({@link PdfKernelDecorator#compose}). */
        public Builder pdfKernelDecorators(List<? extends PdfKernelDecorator> value) { this.pdfKernelDecorators = Objects.requireNonNull(value, "pdfKernelDecorators"); return this; }

        /** Where Datum's observations go. */
        public Builder observations(DatumObservations value) { this.observations = Objects.requireNonNull(value, "observations"); return this; }

        /** Where the run trace goes when {@code datum.runtime.diagnostics.trace} is not off; {@link RunTrace#log()} by default. */
        public Builder runTrace(RunTrace value) { this.runTrace = Objects.requireNonNull(value, "runTrace"); return this; }

        /**
         * Where failed runs are kept when {@code datum.runtime.diagnostics.capture.enabled}, instead of the directory sink over
         * {@code capture.directory} (which is then not needed). The capture's bounds and queue apply to it all the same.
         */
        public Builder captureSink(RunCaptureSink value) { this.captureSink = Objects.requireNonNull(value, "captureSink"); return this; }

        /** Where the startup report's block goes when {@code datum.runtime.diagnostics.report}; INFO on {@value SandboxReport#LOGGER} by default. */
        public Builder reportLog(Consumer<String> value) { this.reportLog = Objects.requireNonNull(value, "reportLog"); return this; }

        /**
         * @throws com.argusvane.datum.sandbox.wasi.EngineSelectionException when no runtime was given and no engine has the
         *     settings' id, or the one that has it is unavailable here
         * @throws com.argusvane.datum.core.DatumConfigurationException when the engine cannot honour the limits (a memory floor)
         * @throws com.argusvane.datum.core.ProgramUnavailableException when the selected engine cannot be made here
         * @throws NullPointerException for an input the setters could not check (a null element of a decorator list); the
         *     checks run before the engine is created, so a refused build leaves no engine open
         * @throws DatumConfigurationException when the capture is enabled with neither {@code capture.directory} nor a sink of
         *     the host's own (also checked before the engine is created)
         */
        public DatumSandbox build() {
            return new DatumSandbox(this);
        }
    }

    private DatumSandbox(Builder builder) {
        SandboxSettings settings = builder.settings;
        ClassLoader loader = builder.loader != null ? builder.loader : defaultLoader();
        ProgramStore store = builder.store != null ? builder.store : settings.programStore(loader);
        ProgramLimits limits = builder.limits != null ? builder.limits : settings.limits(null);
        HostOptions hostOptions = builder.hostOptions != null ? builder.hostOptions : settings.host().hostOptions(builder.clock);
        DatumEventPublisher events = builder.events;
        RunLog runLog = builder.runLog;
        Clock clock = builder.clock;
        Supplier<AbiProbe> probes = builder.probes != null ? builder.probes : () -> new AbiProbe(clock);
        List<? extends SandboxDecorator> sandboxDecorators = builder.sandboxDecorators;
        List<? extends PdfKernelDecorator> pdfKernelDecorators = builder.pdfKernelDecorators;
        DatumObservations observations = builder.observations;
        SandboxSettings.Diagnostics diagnostics = settings.diagnostics();
        CaptureSettings captureSettings = diagnostics.capture();
        // Every input is checked before the engine is created: the sandbox owns the engine it selects, and a build that fails
        // after that point would leave it open with no owner to close it.
        if (captureSettings.enabled() && builder.captureSink == null && captureSettings.directory() == null) {
            throw new DatumConfigurationException(DirectoryCaptureSink.PROPERTY, SandboxSettings.DIAGNOSTICS + "capture.enabled is true and "
                + DirectoryCaptureSink.PROPERTY + " is not set: there is nowhere to keep the failed runs.",
                "Set " + DirectoryCaptureSink.PROPERTY + " to a directory only the JVM's user can read (it is created, mode 700, if it is "
                    + "missing), or set " + SandboxSettings.DIAGNOSTICS + "capture.enabled=false.");
        }
        Supplier<AbiProbe> checkedProbes = Objects.requireNonNull(probes, "probes");
        Objects.requireNonNull(observations, "observations");
        Objects.requireNonNull(sandboxDecorators, "sandboxDecorators").forEach(d -> Objects.requireNonNull(d, "a sandbox decorator"));
        Objects.requireNonNull(pdfKernelDecorators, "pdfKernelDecorators").forEach(d -> Objects.requireNonNull(d, "a PDF kernel decorator"));
        Objects.requireNonNull(store, "store");
        Objects.requireNonNull(limits, "limits");
        Objects.requireNonNull(hostOptions, "hostOptions");
        Objects.requireNonNull(events, "events");
        Objects.requireNonNull(runLog, "runLog");
        GuestRuntime delegate = builder.runtime;
        boolean owned = false;
        if (delegate == null && !builder.noRuntime) {
            delegate = Engines.select(settings, limits, loader);
            owned = true;
        }
        this.probes = checkedProbes;
        this.delegate = delegate;
        this.ownsRuntime = owned;
        // A run asks the harness for its timings only when a trace or a capture will read them.
        this.engineRunner = delegate == null ? null : ProgramRunner.on(delegate, settings.diagnostics().watchesRuns());
        this.store = Objects.requireNonNull(store, "store");
        this.limits = Objects.requireNonNull(limits, "limits");
        this.hostOptions = Objects.requireNonNull(hostOptions, "hostOptions");
        this.settings = Objects.requireNonNull(settings, "settings");
        // As given: through the host's guarded default a listener's failure is logged and never takes a proved
        // runtime DOWN; an application's own publisher owns its failures.
        this.events = Objects.requireNonNull(events, "events");
        this.runLog = Objects.requireNonNull(runLog, "runLog");
        this.engine = engineOf(delegate, settings.engine().id());
        this.pdfRunnable = delegate != null && ProgramRunner.canRunPdf(delegate);
        this.engineSettings = owned ? settings.engine().engineSettings() : builder.engineSettings;
        this.runTrace = builder.runTrace;
        this.clock = clock;
        this.reportLog = builder.reportLog != null ? builder.reportLog : LoggerFactory.getLogger(SandboxReport.LOGGER)::info;
        this.capture = captureSettings.enabled() ? new FailedRunCapture(captureSettings,
            builder.captureSink != null ? builder.captureSink : new DirectoryCaptureSink(captureSettings.directory())) : null;
        boolean watched = diagnostics.watchesRuns();
        this.watched = watched;
        List<SandboxDecorator> sandboxChain = new ArrayList<>();
        sandboxChain.add(GuestRunObservations.sandbox(observations, engine.mode()));
        sandboxChain.addAll(sandboxDecorators);
        this.sandboxes = SandboxDecorator.compose(sandboxChain);
        List<PdfKernelDecorator> pdfChain = new ArrayList<>();
        pdfChain.add(GuestRunObservations.pdfKernel(observations, engine.mode()));
        pdfChain.addAll(pdfKernelDecorators);
        this.pdfKernels = PdfKernelDecorator.compose(pdfChain);
        // Every busy refusal is told to the run observer where it happens, whoever asked: the HTTP routes, a
        // queue consumer, a batch, the definition service.
        // RunSlots.validation's slots and wait; measured (the trace's slotWaitMs) only when runs are watched.
        this.validationSlots = new RunSlots(limits.validationSlots(), Duration.ofSeconds(limits.validationWait()), "validation",
            () -> refused(Program.Kind.SANDBOX), watched);
        this.pdfSlots = new RunSlots(settings.pdfSlots(), settings.pdf().slotWait(), "PDF render", () -> refused(Program.Kind.PDF), watched);
        int id = POOLS.incrementAndGet();
        AtomicInteger threads = new AtomicInteger();
        ThreadFactory factory = runnable -> {
            Thread thread = new Thread(runnable, "datum-sandbox-" + id + "-" + threads.incrementAndGet());
            thread.setDaemon(true);
            return thread;
        };
        // One platform thread per run in flight, none kept idle long: the slots bound how many sandbox runs (validations
        // and the inspect ops alike; SandboxService) and PDF runs there are, so the pool needs no bound of its own.
        this.pool = new ThreadPoolExecutor(0, Integer.MAX_VALUE, 30, TimeUnit.SECONDS, new SynchronousQueue<>(), factory);
        this.stuckLimit = validationSlots.size() + pdfSlots.size();
    }

    // ---------------------------------------------------------------------------------------------- lifecycle

    /**
     * Loads and proves the programs, warms up, then publishes {@link SandboxReadyEvent}. First, an engine that runs
     * the programs as JVM bytecode is refused unless {@link SandboxSettings.Engine#allowBytecode()}: that throws whatever fail-fast says
     * (see {@link #refuseBytecodeUnlessAllowed()}). Past it, with {@code failFast} a failure throws (the host's start
     * fails); without it the runtime is DOWN with the reason. Starting a running runtime does nothing.
     *
     * <p>Before all of it, the effective-settings report is logged when {@code datum.runtime.diagnostics.report} (the default);
     * after the bytecode refusal, the failed-run capture is opened when it is enabled, and a capture that cannot open refuses
     * the start like the bytecode refusal does, whatever fail-fast says.
     *
     * @throws EngineBytecodeException when the engine runs as bytecode and {@value #ALLOW_BYTECODE} is false
     * @throws DatumConfigurationException when the failed-run capture's directory is refused
     * @throws IllegalStateException when a proof fails and {@code failFast} is set
     */
    public void start() {
        synchronized (lock) {
            if (running) {
                return;
            }
            // The programs are read once per start: the report names exactly what the proof then proves.
            ProgramStore.Programs preloaded = null;
            RuntimeException unread = null;
            if (settings.diagnostics().report()) {
                try {
                    preloaded = store.load();
                } catch (RuntimeException e) {
                    unread = e;
                }
                logReport(preloaded, unread);
            }
            refuseBytecodeUnlessAllowed();
            startCapture();
            accepting = true;
            running = true;
            try {
                prove(preloaded, unread);
            } catch (RuntimeException e) {
                markDown(e);
                if (settings.lifecycle().failFast()) {
                    accepting = false;
                    running = false;
                    pool.shutdownNow();
                    stopCapture(settings.lifecycle().shutdownGrace());
                    throw new IllegalStateException("The Datum runtime cannot start: " + reason
                        + " Set datum.runtime.fail-fast=false to start without it (health DOWN, every run answers 503).", e);
                }
                LOG.error("The Datum runtime is DOWN: {} Every run answers 503 until a recheck passes.", reason, e);
            }
        }
    }

    /**
     * The first step of a start: an engine that reports {@link EngineInfo#BYTECODE} (Endive with no native code for the
     * platform or no usable runner, or an application's runtime that says so) does not start unless {@link SandboxSettings.Engine#allowBytecode()},
     * before anything is proved or run. Not softened by {@code failFast}: fail-fast is for a proof that a recheck can pass
     * later, and the platform does not change between rechecks, so a fail-fast=false runtime would only sit DOWN; refusing
     * here means the default never serves on bytecode. The runtime is left DOWN, not running and refusing every run, for a host
     * that catches the refusal. Its reason is a fixed sentence of the id: the engine's notes (a passed-over runner's
     * exception text, which can name a native library's path) stay out of the refusal's health reason, though they go into
     * the exception, which the host prints at start, and reach health details as they always have.
     *
     * @throws EngineBytecodeException naming {@value #ALLOW_BYTECODE}, the engine's reason and the two fixes
     */
    private void refuseBytecodeUnlessAllowed() {
        if (!engine.isBytecode() || settings.engine().allowBytecode()) {
            return;
        }
        EngineBytecodeException refused = new EngineBytecodeException(ALLOW_BYTECODE, engine);
        accepting = false;
        reason = "The " + engine.id() + " engine runs the programs as JVM bytecode here, and " + ALLOW_BYTECODE + " is false.";
        state = SandboxStatus.State.DOWN;
        pool.shutdownNow();
        throw refused;
    }

    /**
     * The startup report of the programs the start read (the ones it then proves), logged once; a report that cannot be made
     * is a WARN, never a refused start.
     */
    private void logReport(ProgramStore.@Nullable Programs loaded, @Nullable RuntimeException unread) {
        try {
            String why = unread == null ? null : unread.getMessage() == null ? unread.getClass().getSimpleName() : unread.getMessage();
            reportLog.accept(report(loaded, why).toString());
        } catch (Throwable e) {
            Guarded.rethrowFatal(e);
            LOG.warn("Datum sandbox: the settings report could not be made ({}).", e.getClass().getName());
        }
    }

    /**
     * Opens the failed-run capture: its sink's checks (the directory's) and its writer. A refusal leaves the sandbox DOWN and
     * refusing runs, as the bytecode refusal does, with a fixed reason: the directory's path stays in the start log.
     */
    private void startCapture() {
        if (capture == null) {
            return;
        }
        try {
            capture.start();
        } catch (RuntimeException e) {
            accepting = false;
            reason = "The failed-run capture could not start (" + DirectoryCaptureSink.PROPERTY + "; the start log says why).";
            state = SandboxStatus.State.DOWN;
            pool.shutdownNow();
            throw e;
        }
    }

    private void stopCapture(Duration within) {
        if (capture != null) {
            capture.stop(within);
        }
    }

    /**
     * Stops taking runs, waits {@code shutdownGrace} for the ones in flight, cancels the rest and shuts the pool
     * down (waiting up to 5 s for its threads); then the failed-run capture writes what it holds in whatever of that same grace
     * is left and drops the rest, counted (one deadline, so a stop never takes longer than the grace
     * plus the pool's 5 s; a predictable shutdown is worth more than the captures of the runs it cancelled). Stopping a stopped
     * runtime does nothing.
     */
    public void stop() {
        synchronized (lock) {
            if (!running) {
                return;
            }
            Duration grace = settings.lifecycle().shutdownGrace();
            long deadline = System.nanoTime() + Math.max(0, grace.toNanos());
            accepting = false;
            state = SandboxStatus.State.STOPPED;
            reason = "The Datum runtime has shut down.";
            awaitInFlight(grace);
            int cancelled = 0;
            for (Future<RunOutput> run : List.copyOf(inFlight)) {
                if (run.cancel(true)) {
                    cancelled++;
                }
            }
            if (cancelled > 0) {
                LOG.warn("Datum runtime: {} run(s) still in flight after the {} s shutdown grace were cancelled.", cancelled,
                    settings.lifecycle().shutdownGrace().toSeconds());
            }
            pool.shutdownNow();
            try {
                pool.awaitTermination(5, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            stopCapture(Duration.ofNanos(Math.max(0, deadline - System.nanoTime())));
            running = false;
        }
    }

    /**
     * {@link #stop()}, then the engine this sandbox selected itself is closed (one a caller handed in with
     * {@link Builder#runtime} stays the caller's). Closing twice does nothing: so a plain-Java host writes
     * {@code try (DatumSandbox sandbox = DatumSandbox.builder().build()) { sandbox.start(); ... }}.
     */
    @Override
    public void close() {
        stop();
        pool.shutdownNow();
        if (closed.compareAndSet(false, true) && ownsRuntime && delegate instanceof AutoCloseable closeable) {
            try {
                closeable.close();
            } catch (Exception e) {
                LOG.warn("Datum sandbox: closing the engine failed: {}", e.toString());
            }
        }
    }

    /** Whether {@link #start()} ran and {@link #stop()} has not. */
    public boolean isRunning() {
        return running;
    }

    // ---------------------------------------------------------------------------------------------- the API

    /**
     * The sandbox service, while the runtime is UP.
     *
     * @throws ProgramUnavailableException (503 {@code server.unavailable}) naming why it is not
     */
    public Sandbox sandbox() {
        Sandbox service = sandboxOrNull();
        if (service == null) {
            throw sandboxUnavailable();
        }
        return service;
    }

    /**
     * A sandbox that is not this runtime's own, wrapped in the chain the runtime's is: Datum's {@code datum.sandbox.run}
     * observation, then the host's {@link SandboxDecorator}s in their order. A
     * binding that lets an application replace the {@link Sandbox} bean applies this to the replacement, so whichever sandbox a
     * request runs on, every decorator sees the run: a replacement can never skip them.
     */
    public Sandbox decorate(Sandbox sandbox) {
        return sandboxes.decorate(Objects.requireNonNull(sandbox, "sandbox"));
    }

    /** As {@link #decorate(Sandbox)}, for a PDF program that is not this runtime's own ({@code datum.pdf.run}, then the host's decorators). */
    public PdfKernel decorate(PdfKernel kernel) {
        return pdfKernels.decorate(Objects.requireNonNull(kernel, "kernel"));
    }

    /** The sandbox while the runtime is UP, else null: the one built for the programs proved last, as the decorators wrapped it. */
    public Sandbox sandboxOrNull() {
        return state == SandboxStatus.State.UP ? sandbox : null;
    }

    /**
     * The refusal of a run while there is no sandbox (503 {@code server.unavailable}), naming why: for a binding that looks
     * the sandbox up elsewhere (a bean) and must refuse exactly as {@link #sandbox()} does when there is none.
     */
    public ProgramUnavailableException sandboxUnavailable() {
        String why = reason;
        return new ProgramUnavailableException("Submissions cannot be checked right now: "
            + (why == null ? "the Datum runtime is between two states; try again." : why));
    }

    /**
     * The PDF program, while the runtime is UP and the program usable: the one built for the program proved last, as the
     * decorators wrapped it. PDF runs take a {@link #pdfSlots()} slot first (the caller's).
     *
     * @throws ProgramUnavailableException (503) naming why it is not
     */
    public PdfKernel pdfProgram() {
        if (state != SandboxStatus.State.UP) {
            throw new ProgramUnavailableException("PDFs cannot be made right now: " + reason);
        }
        PdfKernel program = pdf;
        if (program == null) {
            throw new ProgramUnavailableException("PDFs cannot be made on this server: " + pdfUnavailable);
        }
        return program;
    }

    /** The validation slots ({@code datum.runtime.validation.concurrency}, {@code .wait}). */
    public RunSlots validationSlots() {
        return validationSlots;
    }

    /** The PDF slots ({@code datum.runtime.pdf.concurrency}, {@code .wait}). */
    public RunSlots pdfSlots() {
        return pdfSlots;
    }

    /** The budgets and sizes. */
    public ProgramLimits limits() {
        return limits;
    }

    /** The host's context keys. */
    public HostOptions hostOptions() {
        return hostOptions;
    }

    /**
     * The runtime every run goes through: the delegate behind this runtime's pool, in-flight count, shutdown
     * refusal and interrupted events.
     */
    public ProgramRunner runtime() {
        return guarded;
    }

    /** The settings this sandbox runs with. */
    public SandboxSettings settings() {
        return settings;
    }

    /**
     * Every setting as this sandbox runs with it: {@link SandboxSettings#explain()}, with each value that
     * comes from an input the application supplied in place of the settings shown as {@code REPLACED} with the value in force
     * (the builder's limits, host options or runtime, or a binding's replaced beans; a supplied input equal to what the settings
     * give is not a replacement), and the concurrency entries with the slot count they resolve to.
     */
    public SettingsReport explain() {
        String rt = "datum.runtime.";
        List<Entry> swaps = new ArrayList<>();
        if (delegate != null && !ownsRuntime) {
            if (engineSettings == null) {
                swaps.add(Entry.replaced(rt + "engine", engine.id()));
                swaps.add(Entry.replaced(rt + "stop-grace", "(the supplied runtime's own)"));
                swaps.add(Entry.replaced(rt + "max-strays", "(the supplied runtime's own)"));
            } else {
                if (!SandboxSettings.engineId(engine.id()).equals(settings.engine().id())) {
                    swaps.add(Entry.replaced(rt + "engine", engine.id()));
                }
                if (!engineSettings.stopGrace().equals(settings.engine().stopGrace())) {
                    swaps.add(Entry.replaced(rt + "stop-grace", engineSettings.stopGrace()));
                }
                if (engineSettings.maxStrays() != settings.engine().maxStrays()) {
                    swaps.add(Entry.replaced(rt + "max-strays", engineSettings.maxStrays()));
                }
            }
        }
        ProgramLimits asSet = settings.limits(limits.maxBodyBytes());
        if (limits.validationSeconds() != asSet.validationSeconds()) {
            swaps.add(Entry.replaced(rt + "validation.time-limit", Duration.ofSeconds(limits.validationSeconds())));
        }
        if (limits.validationMemory() != asSet.validationMemory()) {
            swaps.add(Entry.replaced(rt + "validation.memory", limits.validationMemory()));
        }
        if (limits.validationConcurrency() != asSet.validationConcurrency()) {
            swaps.add(Entry.replaced(rt + "validation.concurrency", limits.validationConcurrency()));
        }
        if (limits.validationWait() != asSet.validationWait()) {
            swaps.add(Entry.replaced(rt + "validation.wait", Duration.ofSeconds(limits.validationWait())));
        }
        if (limits.pdfSeconds() != asSet.pdfSeconds()) {
            swaps.add(Entry.replaced(rt + "pdf.time-limit", Duration.ofSeconds(limits.pdfSeconds())));
        }
        if (limits.pdfMemory() != asSet.pdfMemory()) {
            swaps.add(Entry.replaced(rt + "pdf.memory", limits.pdfMemory()));
        }
        HostOptions hostAsSet = settings.host().hostOptions(Clock.systemUTC());
        if (!hostOptions.formulaErrors().equals(hostAsSet.formulaErrors())) {
            swaps.add(Entry.replaced("datum.host.formula-errors", hostOptions.formulaErrors()));
        }
        if (!hostOptions.riskyPatterns().equals(hostAsSet.riskyPatterns())) {
            swaps.add(Entry.replaced("datum.host.risky-patterns", hostOptions.riskyPatterns()));
        }
        if (!hostOptions.zone().equals(hostAsSet.zone())) {
            swaps.add(Entry.replaced("datum.host.time-zone", hostOptions.zone().getId()));
        }
        SettingsReport effective = settings.explain().with(swaps);
        List<Entry> slots = new ArrayList<>();
        Entry validation = effective.get(rt + "validation.concurrency");
        // The setting stays the value (a number, as a JSON reader expects); what it comes to here is beside it.
        if (validation != null && Integer.valueOf(0).equals(validation.value())) {
            slots.add(validation.withResolved("one per CPU", validationSlots.size()));
        }
        Entry pdfConcurrency = effective.get(rt + "pdf.concurrency");
        if (pdfConcurrency != null && Integer.valueOf(0).equals(pdfConcurrency.value())) {
            slots.add(pdfConcurrency.withResolved("min(2, CPUs)", pdfSlots.size()));
        }
        return effective.with(slots);
    }

    /**
     * The effective-settings report: {@link #explain()}, the engine, each program's sha256 and ABI as
     * the last proof that passed proved them (or "not read yet"), and the trace and capture state. What the startup INFO block
     * prints and the actuator's {@code settings} serves ({@link SandboxReport#toJson(boolean)}).
     */
    public SandboxReport report() {
        ProgramStore.Programs loaded = programs;
        return report(loaded, loaded == null ? "not read yet: the sandbox has not proved its programs" : null);
    }

    private SandboxReport report(ProgramStore.@Nullable Programs loaded, @Nullable String unread) {
        List<SandboxReport.ProgramLine> lines = new ArrayList<>();
        if (loaded == null) {
            lines.add(new SandboxReport.ProgramLine("sandbox", null, null, null, unread));
            lines.add(new SandboxReport.ProgramLine("pdf", null, null, null, unread));
        } else {
            lines.add(new SandboxReport.ProgramLine("sandbox", loaded.sandbox().sha256(), loaded.sandboxAbi(), loaded.sandboxSource(), null));
            lines.add(loaded.hasPdf() ? new SandboxReport.ProgramLine("pdf", loaded.pdf().sha256(), loaded.pdfAbi(), loaded.pdfSource(), null)
                : new SandboxReport.ProgramLine("pdf", null, null, null, loaded.pdfUnavailable()));
        }
        SandboxSettings.Diagnostics diagnostics = settings.diagnostics();
        CaptureSettings bounds = diagnostics.capture();
        return new SandboxReport(explain(), engine, lines,
            new SandboxReport.Trace(diagnostics.trace().word(), diagnostics.trace() == TraceMode.OFF ? null : Guarded.describe(runTrace)),
            new SandboxReport.Capture(capture != null, capture == null ? null : capture.describe(), bounds.maxRuns(), bounds.maxBytes(),
                bounds.queueBytes()));
    }

    /** The engine's id: {@code endive}, or the class name of an application's runtime that reports none. */
    public String engine() {
        return engine.id();
    }

    /** What the engine reports about itself: id, version, mode, notes. */
    public EngineInfo engineInfo() {
        return engine;
    }

    /** The state now, for health. */
    public SandboxStatus status() {
        ProgramStore.Programs loaded = programs;
        boolean up = state == SandboxStatus.State.UP;
        return new SandboxStatus(state, up ? null : reason, engine, pdfRunnable,
            up && loaded != null ? loaded.sandboxAbi() : null,
            up && loaded != null && pdf != null ? loaded.pdfAbi() : null,
            pdf == null ? (pdfUnavailable != null ? pdfUnavailable : (up ? null : reason)) : null,
            validationSlots.size(), validationSlots.available(), pdfSlots.size(), pdfSlots.available(), inFlight.size(), warmUpMillis,
            stuck.get(), strayRunsOf(delegate), capture == null ? null : capture.counts());
    }

    /**
     * Proves the runtime again for the actuator: reads the program overrides afresh, asks both programs for
     * their ABI (a fresh gate, so a proof is not taken from memory), warms up, refreshes the status. A failure
     * leaves the runtime DOWN with the reason; it never throws. A stopped runtime is not restarted.
     */
    public SandboxStatus recheck() {
        synchronized (lock) {
            if (!running) {
                return status();
            }
            try {
                prove();
            } catch (RuntimeException e) {
                markDown(e);
                LOG.error("Datum runtime recheck failed: {}", reason, e);
            }
            return status();
        }
    }

    /**
     * Watches every run that goes through {@link #runtime()} (the metrics binder's seam: metrics
     * observe, they never change an answer). A watcher that throws is logged and ignored.
     */
    @FunctionalInterface
    public interface RunObserver {

        /**
         * @param kind which program ran
         * @param outcome the run's {@code Termination} in lower case, or a {@code SandboxException} reason in
         *     lower case, or {@code error}
         * @param elapsed from entering the runtime (slot already held) to the answer
         */
        void ran(Program.Kind kind, String outcome, Duration elapsed);

        /**
         * A run's thread picked it up: how long it sat between the runtime accepting it and starting it (the
         * pool's hand-off). The wait for a slot happens before the runtime is entered and is not seen here.
         */
        default void started(Program.Kind kind, Duration waited) {
        }

        /**
         * A run was refused because every slot of its program stayed taken (503 {@code server.busy}), told by
         * the slots themselves, so a caller that never reaches an HTTP error mapper (a queue, a batch) is counted too.
         */
        default void refused(Program.Kind kind) {
        }
    }

    /** Tells the observer of a busy refusal; one that throws is logged and the refusal stays busy. */
    private void refused(Program.Kind kind) {
        RunObserver watcher = observer;
        if (watcher == null) {
            return;
        }
        try {
            watcher.refused(kind);
        } catch (RuntimeException e) {
            LOG.warn("A run observer failed: {}", e.toString());
        }
    }

    /** Sets the run watcher (null removes it). */
    public void observer(RunObserver observer) {
        this.observer = observer;
    }

    /** The runs cancelled past the backstop whose threads are still going. */
    public int stuckRuns() {
        return stuck.get();
    }

    /** The backstop past a run's budget and the wait after its cancel (tests shorten both). */
    void timeouts(Duration backstopPastBudget, Duration cancelWait) {
        this.backstop = Objects.requireNonNull(backstopPastBudget, "backstopPastBudget");
        this.stopGrace = Objects.requireNonNull(cancelWait, "cancelWait");
    }

    // ---------------------------------------------------------------------------------------------- proving

    /** A proof of programs the store reads now (a recheck). */
    private void prove() {
        prove(null, null);
    }

    /**
     * A proof of the programs the start already read ({@code preloaded}, or the failure of that read), or of what the store
     * reads now when the start did not read them.
     */
    private void prove(ProgramStore.@Nullable Programs preloaded, @Nullable RuntimeException unread) {
        proofSeconds.set((int) settings.lifecycle().startupBudget().toSeconds());
        try {
            proveWithin(preloaded, unread);
        } finally {
            proofSeconds.remove();
        }
    }

    private void proveWithin(ProgramStore.@Nullable Programs preloaded, @Nullable RuntimeException unread) {
        if (delegate == null) {
            throw new ProgramUnavailableException("There is no GuestRuntime: add datum-sandbox-endive (the submissions starter "
                + "brings it, with datum.runtime.engine=endive) or define a GuestRuntime bean.");
        }
        if (unread != null) {
            throw unread;
        }
        ProgramStore.Programs loaded = preloaded != null ? preloaded : store.load();
        // The services of this proof name the ABIs of the programs they run, whatever a later proof loads; nothing is
        // published for the report until the proof has passed.
        Recorder recorder = watched ? new Recorder(settings.diagnostics().trace(), loaded) : null;
        // A fresh gate: a recheck proves again rather than trusting an earlier proof of the same file. The host supplies it
        // (the binding's is a prototype on the application's clock).
        AbiProbe probe = Objects.requireNonNull(probes.get(), "The AbiProbe supplier answered null.");
        if (probe == lastProbe && !sharedProbeWarned) {
            sharedProbeWarned = true;
            LOG.warn("Datum runtime: the AbiProbe supplier answered the gate of the previous proof again, so this recheck trusts the "
                + "proofs it remembers (the same program file is not asked again). Supply a fresh AbiProbe per call (a prototype bean).");
        }
        lastProbe = probe;
        // Built here over this runtime's guarded engine, then handed to the decorators (Datum's observation first), so a decorator
        // sees the proof, the warm-ups and every run, and no decorator can build its sandbox over other parts.
        Sandbox service = sandboxes.decorate(new SandboxService(guarded, loaded.sandbox(), new RunScript(loaded.freezeSnippet()), limits,
            hostOptions, validationSlots, probe, runLog, recorder));
        service.proveAbi();

        PdfKernel pdfProgram = null;
        String pdfReason = loaded.pdfUnavailable();
        if (loaded.hasPdf()) {
            if (!pdfRunnable) {
                // The PDF path is unavailable on bytecode (and the protocol's runner refuses such a
                // run itself), so no PDF run is tried. A fixed sentence of the id and mode: the notes can carry a
                // passed-over runner's exception text (a native library's file path), and pdfUnavailable is on the
                // actuator read, which strips engineNotes for that reason. The WARN below logs them.
                pdfReason = "The " + engine.id() + " engine cannot run the PDF program here (mode " + engine.mode() + ").";
            } else {
                // Built over the guarded engine and decorated as the sandbox is: a decorator sees the PDF program's ABI proof
                // (its capabilities run) and every PDF run after it.
                pdfProgram = pdfKernels.decorate(new PdfProgram(guarded, loaded.pdf(), limits, probe, recorder));
                pdfProgram.capabilities();
            }
        }

        long started = System.nanoTime();
        for (int i = 0; i < settings.lifecycle().warmUpRuns(); i++) {
            Sandbox.Smoke smoke = service.smoke();
            if (!smoke.ok()) {
                throw new ProgramUnavailableException("Warm-up run " + (i + 1) + " did not give the expected verdict: " + smoke.message());
            }
        }
        long millis = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started);

        programs = loaded;
        sandbox = service;
        pdf = pdfProgram;
        pdfUnavailable = pdfProgram == null ? pdfReason : null;
        warmUpMillis = millis;
        reason = null;
        state = SandboxStatus.State.UP;
        if (pdfProgram == null) {
            // The engine's notes go to the log (an operator's), never into the reason a read answers.
            LOG.warn("Datum: the PDF program is unavailable: {}{}", pdfReason,
                engine.notes().isEmpty() || loaded.pdfUnavailable() != null ? "" : " " + Guarded.scrub(engine.notes()));
        }
        LOG.info("Datum runtime UP: engine {} {} ({}), sandbox ABI {} ({}), PDF ABI {}, {} warm-up run(s) in {} ms.", engine.id(),
            engine.version(), engine.mode(), loaded.sandboxAbi(), loaded.sandboxSource(), pdfProgram == null ? "unavailable" : loaded.pdfAbi(),
            settings.lifecycle().warmUpRuns(), millis);
        // Through the host's guarded default a listener that throws is logged and the runtime stays UP; an
        // application's own publisher that throws here fails the start (or, without fail-fast, leaves the runtime DOWN).
        events.publish(new SandboxReadyEvent(engine, loaded.sandboxAbi(), pdfProgram == null ? null : loaded.pdfAbi(), millis));
    }

    private void markDown(RuntimeException e) {
        String message = e.getMessage();
        reason = message == null || message.isBlank() ? e.getClass().getSimpleName() : message;
        state = SandboxStatus.State.DOWN;
    }

    /**
     * The runs a runtime stopped whose threads are still alive ({@code GuestRuntime.strayRuns()}); -1 when there is no
     * runtime, it does not count them, or the count throws (health must not fail on it).
     */
    static int strayRunsOf(GuestRuntime runtime) {
        if (runtime == null) {
            return -1;
        }
        try {
            return runtime.strayRuns();
        } catch (RuntimeException e) {
            return -1;
        }
    }

    /**
     * What the engine reports, or for no runtime the configured id with mode {@code none}. A runtime whose
     * {@code engineInfo()} throws is described by its class name: a report must not stop the start.
     */
    static EngineInfo engineOf(GuestRuntime runtime, String configured) {
        if (runtime == null) {
            return new EngineInfo(configured == null || configured.isBlank() ? "none" : configured, EngineInfo.UNKNOWN, NO_ENGINE,
                "No GuestRuntime is configured.");
        }
        try {
            EngineInfo info = runtime.engineInfo();
            return info != null ? info : EngineInfo.unreported(runtime.getClass().getName());
        } catch (RuntimeException e) {
            LOG.warn("Datum runtime: the GuestRuntime's engineInfo() failed ({}); it is described by its class name.", e.toString());
            return EngineInfo.unreported(runtime.getClass().getName());
        }
    }

    // ---------------------------------------------------------------------------------------------- diagnostics

    /**
     * What the protocol's services hand each judged run to while the trace or the capture is on,
     * one per proof, over the programs that proof loaded: the run gets a random run id (never its nonce), its program's ABI as
     * its own service's programs say, the engine and its slot wait. The slot wait is read while the run still holds its slot;
     * the rest is done on the same thread once the slot is released ({@link RunSlots#afterRelease}): a failed run is captured
     * when the capture is on (queued, never written on this thread) and the trace record names the capture's id, or
     * {@code dropped}; then the record goes to the {@link RunTrace} when the mode traces it. Whatever either throws, an Error
     * included, the run's answer stands ({@link Guarded#rethrowFatal}). A normal verdict under {@code failures} with the capture
     * off costs this one check.
     */
    private final class Recorder implements RunRecorder {

        private final TraceMode trace;
        private final ProgramStore.Programs loaded;
        /** The report's JSON for these programs, made at the first capture, for every capture's meta.json. */
        private volatile @Nullable Map<String, Object> reportJson;

        Recorder(TraceMode trace, ProgramStore.Programs loaded) {
            this.trace = trace;
            this.loaded = loaded;
        }

        @Override
        public void ran(RunFacts facts) {
            boolean failed = facts.failed();
            boolean traced = trace.traces(failed);
            FailedRunCapture keep = failed ? capture : null;
            if (!traced && keep == null) {
                return;
            }
            RunSlots slots = "pdf".equals(facts.program()) ? pdfSlots : validationSlots;
            long slotWait = slots.heldWaitNanos();
            slots.afterRelease(() -> deliver(facts, slotWait, traced, keep));
        }

        /** The trace record and the capture of one run, made after its slot is free. */
        private void deliver(RunFacts facts, long slotWait, boolean traced, @Nullable FailedRunCapture keep) {
            TraceRecord record;
            try {
                record = record(facts, slotWait);
            } catch (Throwable e) {
                Guarded.rethrowFatal(e);
                if (keep != null) {
                    keep.lost("its record could not be made (" + e.getClass().getName() + ")");
                }
                LOG.warn("Datum: the run diagnostics failed ({}); the run's answer is unchanged.", e.getClass().getName());
                return;
            }
            if (keep != null) {
                String captureId = RunCapture.id(clock.instant(), record.run());
                TraceRecord queued = record.withCapture(captureId);
                boolean kept;
                try {
                    kept = keep.offer(RunCapture.of(captureId, facts, meta(queued, facts)));
                } catch (Throwable e) {
                    // An OutOfMemoryError building the capture of a run that itself ran out of heap is this capture's loss.
                    Guarded.rethrowFatal(e);
                    keep.lost("it could not be assembled (" + e.getClass().getName() + ")");
                    kept = false;
                }
                record = kept ? queued : record.withCapture("dropped");
            }
            if (traced) {
                try {
                    runTrace.trace(record);
                } catch (Throwable e) {
                    Guarded.rethrowFatal(e);
                    LOG.warn("Datum: the run trace failed ({}); the run's answer is unchanged.", e.getClass().getName());
                }
            }
        }

        private TraceRecord record(RunFacts facts, long slotWait) {
            byte[] id = new byte[6];
            RUN_IDS.nextBytes(id);
            String runId = HexFormat.of().formatHex(id);
            RunOutput output = facts.output();
            RunTimings timings = output == null ? null : output.timings();
            return new TraceRecord(runId, facts.program(), facts.op(), abiOf(facts.sha256()), engine.id(), engine.mode(),
                slotWait, timings == null ? -1 : timings.prepareNanos(), timings == null ? -1 : timings.instantiateNanos(),
                timings == null ? -1 : timings.startNanos(), facts.totalNanos(),
                output == null ? null : output.termination().name().toLowerCase(Locale.ROOT),
                output != null && output.termination() == Termination.EXITED ? output.exitCode() : null, facts.outcome(),
                facts.stdin().remaining(), output == null ? 0 : output.stdoutLength(), output == null ? 0 : output.stderrLength(), null,
                facts.failed());
        }

        /** The ABI this proof's store read for the program of this sha256, or null when the run's program is not one of them. */
        private @Nullable String abiOf(String sha256) {
            if (loaded.sandbox().sha256().equals(sha256)) {
                return loaded.sandboxAbi();
            }
            if (loaded.hasPdf() && loaded.pdf().sha256().equals(sha256)) {
                return loaded.pdfAbi();
            }
            return null;
        }

        /** The full report's JSON for these programs, made once. */
        private Map<String, Object> reportJson() {
            Map<String, Object> json = reportJson;
            if (json == null) {
                json = report(loaded, null).toJson(false);
                reportJson = json;
            }
            return json;
        }

        /** A capture's meta.json: the trace fields, the program's sha256 and ABI, the engine and the full settings report. */
        private Map<String, Object> meta(TraceRecord record, RunFacts facts) {
            Map<String, Object> meta = new LinkedHashMap<>();
            meta.put("capture", record.capture());
            meta.put("trace", record.fields());
            Map<String, Object> program = new LinkedHashMap<>();
            program.put("program", facts.program());
            program.put("sha256", facts.sha256());
            program.put("abi", record.abi());
            meta.put("program", program);
            Map<String, Object> engineJson = new LinkedHashMap<>();
            engineJson.put("id", Guarded.scrub(engine.id()));
            engineJson.put("version", Guarded.scrub(engine.version()));
            engineJson.put("mode", Guarded.scrub(engine.mode()));
            engineJson.put("notes", Guarded.scrub(engine.notes()));
            meta.put("engine", engineJson);
            meta.put("settings", reportJson());
            return meta;
        }
    }

    /** The failed-run capture's counts, or null when it is off (what health shows as {@code capture}). */
    public FailedRunCapture.@Nullable Counts captureCounts() {
        return capture == null ? null : capture.counts();
    }

    // ---------------------------------------------------------------------------------------------- runs

    private void awaitInFlight(Duration grace) {
        long deadline = System.nanoTime() + Math.max(0, grace.toNanos());
        while (!inFlight.isEmpty()) {
            long left = deadline - System.nanoTime();
            if (left <= 0) {
                return;
            }
            Future<RunOutput> run = inFlight.stream().findFirst().orElse(null);
            if (run == null) {
                return;
            }
            try {
                run.get(left, TimeUnit.NANOSECONDS);
            } catch (TimeoutException e) {
                return;
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            } catch (ExecutionException | CancellationException e) {
                // Done one way or another; its caller removes it.
            }
            inFlight.remove(run);
        }
    }

    /** The delegate behind the pool: refused after stop, counted while in flight, cancellable at shutdown. */
    private final class GuardedRuntime implements ProgramRunner {

        @Override
        public RunOutput run(Program program, String runScript, List<String> argv, byte[] stdin, Budget budget) {
            Integer proof = proofSeconds.get();
            if (proof != null && proof > budget.seconds()) {
                budget = new Budget(proof, budget.memoryBytes(), budget.stdoutCap(), budget.stderrCap());
            }
            RunObserver watcher = observer;
            if (watcher == null) {
                return guardedRun(program, runScript, argv, stdin, budget);
            }
            long entered = System.nanoTime();
            String outcome = "error";
            try {
                RunOutput output = guardedRun(program, runScript, argv, stdin, budget);
                outcome = output == null ? "none" : output.termination().name().toLowerCase(java.util.Locale.ROOT);
                return output;
            } catch (SandboxException e) {
                outcome = e.reason().name().toLowerCase(java.util.Locale.ROOT);
                throw e;
            } finally {
                try {
                    watcher.ran(program.kind(), outcome, Duration.ofNanos(System.nanoTime() - entered));
                } catch (RuntimeException e) {
                    LOG.warn("A run observer failed: {}", e.toString());
                }
            }
        }

        private RunOutput guardedRun(Program program, String runScript, List<String> argv, byte[] stdin, Budget budget) {
            ProgramRunner runner = engineRunner;
            if (!accepting || runner == null) {
                return interrupted();
            }
            if (stuck.get() >= stuckLimit) {
                // A fault of the runtime (it did not stop its guests), so 503 server.unavailable, not the retryable
                // server.busy of slot exhaustion.
                throw new ProgramUnavailableException("Every run slot's guest is still going after its cancel ("
                    + stuck.get() + " stuck run(s)); no new run starts until they end.");
            }
            Tracked task = new Tracked(() -> runner.run(program, runScript, argv, stdin, budget), program.kind());
            // In flight before the pool thread can start it: a stop() that lands between the submit and the
            // registration would otherwise see no run to wait for and cancel this one with no grace at all
            // (the CI runners, two cores and loaded, hit exactly that window).
            FutureTask<RunOutput> run = new FutureTask<>(task);
            inFlight.add(run);
            try {
                pool.execute(run);
            } catch (RejectedExecutionException e) {
                inFlight.remove(run);
                return interrupted();
            }
            long started = System.nanoTime();
            try {
                RunOutput output = run.get(TimeUnit.SECONDS.toNanos(budget.seconds()) + backstop.toNanos(), TimeUnit.NANOSECONDS);
                if (output != null) {
                    reportStopped(program, output.termination(), started);
                }
                return output;
            } catch (ExecutionException e) {
                Throwable cause = e.getCause();
                if (cause instanceof RuntimeException runtime) {
                    throw runtime;
                }
                if (cause instanceof Error error) {
                    throw error;
                }
                throw new ProgramUnavailableException("The runtime failed: " + cause, cause);
            } catch (CancellationException e) {
                // Cancelled at shutdown: nothing was judged.
                return interrupted();
            } catch (InterruptedException e) {
                run.cancel(true);
                // The caller was interrupted: no wait, but a guest that goes on still counts.
                task.abandon(Duration.ZERO);
                Thread.currentThread().interrupt();
                return interrupted();
            } catch (TimeoutException e) {
                run.cancel(true);
                // The caller's slot is released when this returns: wait for the guest to end first, as Endive does
                // for its own stopped runs, and count it as stuck if it does not.
                boolean ended = task.abandon(stopGrace);
                LOG.error("Datum runtime: a {} run was still going {} past its {} s budget and was cancelled{}; the runtime "
                    + "({}) does not enforce its budget.", program.kind().fileName(), backstop, budget.seconds(),
                    ended ? "" : " but its thread has not ended (" + stuck.get() + " stuck of " + stuckLimit + " allowed)", engine.id());
                // It passed its budget either way, so its caller gets the budget answer (503 wasm.execution_error), not
                // server.unavailable: STUCK when its thread is still going (counted above; the trace and the metrics say
                // "stuck"), BUDGET when it ended within the wait. Neither is the guest's own stop: no stdout is kept.
                return new RunOutput(ended ? Termination.BUDGET : Termination.STUCK, -1, null, null, null);
            } finally {
                inFlight.remove(run);
            }
        }

        private RunOutput interrupted() {
            return new RunOutput(Termination.INTERRUPTED, -1, null, null, null);
        }

        /**
         * One run on the pool, knowing whether its thread is still in the delegate. A cancel stops a task that
         * has not started; one already in the delegate ends only when the runtime lets it, which is what
         * {@link #abandon} waits for and counts.
         */
        private final class Tracked implements Callable<RunOutput> {

            private final Callable<RunOutput> work;
            private final AtomicInteger phase = new AtomicInteger(NEW);
            private final CountDownLatch ended = new CountDownLatch(1);

            private final Program.Kind kind;
            private final long submitted = System.nanoTime();

            Tracked(Callable<RunOutput> work, Program.Kind kind) {
                this.work = work;
                this.kind = kind;
            }

            @Override
            public RunOutput call() throws Exception {
                if (!phase.compareAndSet(NEW, RUNNING)) {
                    ended.countDown();
                    return interrupted();
                }
                RunObserver watcher = observer;
                if (watcher != null) {
                    try {
                        watcher.started(kind, Duration.ofNanos(System.nanoTime() - submitted));
                    } catch (RuntimeException e) {
                        LOG.warn("A run observer failed: {}", e.toString());
                    }
                }
                try {
                    return work.call();
                } finally {
                    if (!phase.compareAndSet(RUNNING, ENDED)) {
                        // Counted as stuck by its abandoning caller: it has ended now.
                        phase.set(ENDED);
                        int left = stuck.decrementAndGet();
                        LOG.warn("Datum runtime: a run cancelled past its budget has ended after all ({} still stuck).", left);
                    }
                    ended.countDown();
                }
            }

            /**
             * After a cancel: waits up to {@code wait} for the run's thread to leave the delegate.
             *
             * @return true when it never started or has ended; false when it is still going (counted as stuck)
             */
            boolean abandon(Duration wait) {
                if (phase.compareAndSet(NEW, DROPPED)) {
                    return true;
                }
                if (!wait.isZero() && !wait.isNegative()) {
                    try {
                        if (ended.await(wait.toNanos(), TimeUnit.NANOSECONDS)) {
                            return true;
                        }
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }
                }
                stuck.incrementAndGet();
                if (phase.compareAndSet(RUNNING, STUCK)) {
                    return false;
                }
                // It ended between the wait and the mark.
                stuck.decrementAndGet();
                return true;
            }
        }

        private void reportStopped(Program program, Termination termination, long started) {
            String reasonWord = switch (termination) {
                case BUDGET -> "budget";
                case MEMORY -> "memory";
                case TRAP -> "trap";
                case OUTPUT_CAP -> "output-cap";
                default -> null;
            };
            if (reasonWord == null) {
                return;
            }
            String which = program.kind() == Program.Kind.PDF ? "pdf" : "sandbox";
            // Through the host's guarded default a listener's failure is logged and the run's own answer goes
            // on; an application's own publisher is used as given, so its failure replaces the run's answer (a budget,
            // memory or trap refusal) with its own exception: it owns that failure.
            events.publish(new SandboxRunInterruptedEvent(which, reasonWord, Duration.ofNanos(System.nanoTime() - started)));
        }
    }
}
