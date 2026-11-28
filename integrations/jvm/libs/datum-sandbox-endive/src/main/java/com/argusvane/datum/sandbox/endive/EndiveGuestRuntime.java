package com.argusvane.datum.sandbox.endive;

import com.argusvane.datum.sandbox.wasi.Budget;
import com.argusvane.datum.sandbox.wasi.EngineInfo;
import com.argusvane.datum.sandbox.wasi.EngineSettings;
import com.argusvane.datum.sandbox.wasi.GuestEngine;
import com.argusvane.datum.sandbox.wasi.GuestIo;
import com.argusvane.datum.sandbox.wasi.GuestRun;
import com.argusvane.datum.sandbox.wasi.GuestRuntime;
import com.argusvane.datum.sandbox.wasi.RunHarness;
import com.argusvane.datum.sandbox.wasi.RunOutput;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import run.endive.redline.experimental.api.NativeMachineFactoryProvider;
import run.endive.runtime.ImportValues;
import run.endive.runtime.Instance;
import run.endive.runtime.Memory;
import run.endive.runtime.WasmInterruptedException;
import run.endive.wasi.WasiExitException;
import run.endive.wasi.WasiOptions;
import run.endive.wasi.WasiPreview1;
import run.endive.wasm.WasmEngineException;
import run.endive.wasm.types.MemoryLimits;

/**
 * {@link GuestRuntime} over Endive: one QuickJS instance per run, on datum-sandbox's {@link RunHarness}, which
 * owns everything about a run that is not Endive's: the platform worker thread, the stop at the budget (never during
 * set-up), the fresh read-only in-memory {@code /app} holding only the run's files, the bounded streams, the
 * stray-run bound and the reading of how a run ended. This class is the Endive half ({@link GuestEngine}):
 * <ul>
 *   <li>WASI preview 1 over exactly what the harness hands a run: the argv, stdin, the bounded stdout and stderr (a cap's
 *       exception propagates out of {@code fd_write}, which Endive's WASI layer does not catch, so the run ends at once),
 *       {@code /app} as the only preopen, no environment, and the harness's fixed realtime clock and per-run
 *       {@code random_get} stream ({@link GuestIo}: the same date and the same bytes on every run). Endive's WASI reads the
 *       realtime clock from that {@code Clock} and the monotonic one from {@code System.nanoTime()}, which no option
 *       replaces: the monotonic clock stays the host's, so sleeps and the {@code qjs:os} timers keep real time and a stop
 *       still lands (an interrupt ends a sleep at once);</li>
 *   <li>linear memory limited to {@code budget.memoryBytes / 65536} pages from the module's own initial pages
 *       ({@link #QJS_PAGES}); past it QuickJS's allocator fails (memory.grow answers -1) and QuickJS reports it;</li>
 *   <li>the precompiled module on the runner {@link ProviderSelector} chose: {@code provider.builder(Qjs.load(),
 *       Qjs.loadNativeCode())} natively, {@code Qjs.safeBuilder()} as bytecode, which {@link EngineInfo#mode()} says (the
 *       Datum lifecycle and protocol refuse the PDF program there, never this engine: it runs no program, only files);</li>
 *   <li>the guest's C stack held to its 64 KiB ({@link StackGuard}): the build compiles a rewrite of the pinned module in
 *       which every move of the stack pointer past the stack's floor traps before the frame is used, and each run arms a
 *       canary over the stack's lowest bytes before {@code _start} and reads it, with the module's {@code .rodata}, after;
 *       a run that reached the floor is a trap with {@link StackGuard#OVERRUN}, however the guest ended;</li>
 *   <li>Endive's exceptions read: {@link WasiExitException} is an exit with its code; another {@link WasmEngineException}
 *       after {@code _start} is a trap ({@code TrapException} "call stack exhausted", "unreachable"; QuickJS reports its
 *       own memory limit as an exit, never as an engine fault); {@link WasmInterruptedException} is an
 *       interrupt; {@code WasmEngineException("out of memory")} is Endive's wrap of the JVM out of heap.</li>
 * </ul>
 *
 * <p>Every instance is built with {@code withStart(false)} and {@code _start} is called by the harness inside its
 * try-with-resources, never by {@code build()}: a run that ends through {@code proc_exit} (a throw, a trap, an exit, a
 * cancellation) would otherwise leave {@code build()} with an exception before there is an instance to close, and leak
 * its whole linear memory off-heap. The
 * harness never interrupts {@code build()} (it maps the linear memory before it constructs the instance; repeated stops
 * during set-up leaked a whole memory limit of address space each), and should {@code build()} fail
 * for another reason (the JVM out of heap mid-set-up) the native memories it made are closed here before the failure goes
 * on. Each native instance also costs a few MiB of heap (what one warm run allocates: under 8 MiB on the Panama runner,
 * under 2 MiB on JFFI; the start-up memory check counts {@code MemoryBudget.SETUP_HEAP} a slot) and about 0.4 s of set-up,
 * and its linear memory lives off-heap (mmap) under a native runner, on the heap under bytecode.
 */
public final class EndiveGuestRuntime implements GuestRuntime, AutoCloseable {

    private static final Logger LOG = LoggerFactory.getLogger(EndiveGuestRuntime.class);

    /** The engine's id: the value of {@code datum.runtime.engine} that selects it. */
    public static final String ID = "endive";

    /** A WebAssembly page. */
    public static final int PAGE_BYTES = 65536;

    /**
     * The module's own initial memory in pages: the least a limit may keep. Endive neither clamps nor refuses a
     * maximum below it at build, and the run then traps or cannot allocate its context.
     */
    static final int QJS_PAGES = Qjs.load().memorySection().orElseThrow(() -> new IllegalStateException("qjs-wasi.wasm declares no memory"))
        .getMemory(0).limits().initialPages();

    /** How long a stopped run's thread is given to end and close its instance before its output is read anyway. */
    public static final Duration STOP_GRACE = EngineSettings.DEFAULT_STOP_GRACE;

    /**
     * How many stopped runs may outlive {@link #STOP_GRACE} before new runs are refused: the default slot count (one
     * per CPU this JVM may use), at least two.
     */
    static final int MAX_STRAYS = EngineSettings.defaultMaxStrays();

    /** The Panama native-access WARN, once per JVM. */
    private static final AtomicBoolean NATIVE_ACCESS_WARNED = new AtomicBoolean();

    private final ProviderSelector.Selection selection;
    private final RuntimeInfo info;
    private final EngineInfo engineInfo;
    private final RunHarness harness;
    private final StackGuard stackGuard;
    /** Native memories made for instances and not yet handed to a close (tests read it). */
    private final AtomicInteger unclosedMemories = new AtomicInteger();
    /** Native memories closed here because build() failed after making them (tests read it). */
    private final AtomicInteger closedAfterFailedBuild = new AtomicInteger();
    /** Tests only: when set, a started run's thread waits for it, ignoring interrupts, before it closes its instance. */
    volatile CountDownLatch holdBeforeCloseForTests;
    /** Tests only: run on the run's thread just before {@code build()}. */
    volatile Runnable beforeBuildForTests;

    /** A runtime on the runner {@link ProviderSelector#select()} picks for this JVM, logged once. */
    public EndiveGuestRuntime() {
        this(ProviderSelector.select());
    }

    /** A runtime on the runner this JVM gets, with the harness's stop grace and stray bound as given. */
    public EndiveGuestRuntime(EngineSettings settings) {
        this(ProviderSelector.select(), settings);
    }

    /** A runtime on a given selection (tests). */
    EndiveGuestRuntime(ProviderSelector.Selection selection) {
        this(selection, EngineSettings.defaults());
    }

    /** A runtime with its stop grace and stray limit open (tests). */
    EndiveGuestRuntime(ProviderSelector.Selection selection, Duration stopGrace, int maxStrays) {
        this(selection, new EngineSettings(stopGrace, maxStrays));
    }

    EndiveGuestRuntime(ProviderSelector.Selection selection, EngineSettings settings) {
        this.selection = Objects.requireNonNull(selection, "selection");
        Objects.requireNonNull(settings, "settings");
        this.info = RuntimeInfo.of(selection, minimumMemoryBytes());
        this.stackGuard = StackGuard.load(Qjs.load(), info.qjsSha256());
        this.engineInfo = engineInfo(selection, info, stackGuard);
        this.harness = new RunHarness(new Engine(), settings);
        if (selection.runner().isNative()) {
            LOG.info("Datum Endive runtime: QuickJS {} runs native on the {} runner: {}.", info.qjsVersion(), selection.runner().id(),
                selection.reason());
        } else {
            LOG.warn("Datum Endive runtime: QuickJS {} runs as JVM bytecode on {}: {}. Validation is several times slower "
                + "and the PDF program is not usable; add datum-sandbox-endive-jffi (Java 17+) or -panama (Java 25+) on a "
                + "supported platform.", info.qjsVersion(), ProviderSelector.platform(), selection.reason());
        }
        warnIfNativeAccessDisabled(selection.runner(), ProviderSelector.nativeAccessBeforeSelection(), NATIVE_ACCESS_WARNED);
    }

    /**
     * What health, info and the ready event report: id {@code endive}, Endive's release, the runner as the mode, why, and
     * the C stack guard.
     */
    static EngineInfo engineInfo(ProviderSelector.Selection selection, RuntimeInfo info, StackGuard stackGuard) {
        String quickJs = "QuickJS " + info.qjsVersion() + " (qjs-wasi.wasm sha256 " + info.qjsSha256() + ")";
        String notes = selection.runner().isNative()
            ? quickJs + " on the " + selection.runner().id() + " runner: " + selection.reason() + "."
            : quickJs + " runs as JVM bytecode on " + ProviderSelector.platform() + ": " + selection.reason() + ". Validation is several "
                + "times slower and the PDF program cannot run in its budget; add datum-sandbox-endive-jffi (Java 17+) or -panama "
                + "(Java 25+) on a supported platform.";
        return new EngineInfo(ID, info.endiveVersion(), selection.runner().id(), notes + " " + stackGuard.describe() + ".");
    }

    @Override
    public EngineInfo engineInfo() {
        return engineInfo;
    }

    /** The runner QuickJS runs on: "panama", "jffi" or "bytecode" (the engine's {@link EngineInfo#mode()}). */
    public String nativeProvider() {
        return selection.runner().id();
    }

    /** Whether QuickJS runs as native code (the PDF program needs it: the lifecycle reads that from the mode). */
    public boolean isNative() {
        return selection.runner().isNative();
    }

    /** The runner and the pinned QuickJS module, in Endive's own terms. */
    public RuntimeInfo info() {
        return info;
    }

    /**
     * The least memory budget a run may have: the module's initial memory. The provider refuses limits below it at
     * creation; the protocol's floor (4 MiB, {@code ProgramLimits.VALIDATION_MEMORY}) is far above it.
     */
    public static long minimumMemoryBytes() {
        return (long) QJS_PAGES * PAGE_BYTES;
    }

    @Override
    public RunOutput run(GuestRun run) {
        return harness.run(run);
    }

    /** The instance's memory limits for a budget: the module's initial pages up to the budget, floored to a page. */
    static MemoryLimits limits(Budget budget) {
        long pages = Math.min(budget.memoryBytes() / PAGE_BYTES, MemoryLimits.MAX_PAGES);
        if (pages < QJS_PAGES) {
            throw new IllegalArgumentException("A run's memory budget is at least the QuickJS module's initial memory, "
                + minimumMemoryBytes() + " bytes; this one is " + budget.memoryBytes() + ".");
        }
        return new MemoryLimits(QJS_PAGES, (int) pages);
    }

    /**
     * Whether a failure is the JVM out of heap: an {@link OutOfMemoryError} anywhere in its causes, or the engine's
     * {@code WasmEngineException("out of memory")}, which Endive throws only around a caught {@code OutOfMemoryError}.
     */
    static boolean outOfHeap(Throwable failure) {
        return RunHarness.outOfHeap(failure, EndiveGuestRuntime::endiveOutOfHeap);
    }

    private static boolean endiveOutOfHeap(Throwable link) {
        return link instanceof WasmEngineException && String.valueOf(link.getMessage()).contains("out of memory");
    }

    /** Stopped runs whose thread is still alive past the grace (health reports it; tests read it). */
    @Override
    public int strayRuns() {
        return harness.strayRuns();
    }

    /** Native memories made and not yet handed to a close: 0 when no run is in flight (tests). */
    int unclosedMemories() {
        return unclosedMemories.get();
    }

    /** Native memories closed because {@code build()} failed after making them (tests). */
    int closedAfterFailedBuild() {
        return closedAfterFailedBuild.get();
    }

    /**
     * Stops every run in flight the way a budget does (they end as {@code INTERRUPTED}; one still in set-up is closed
     * without starting) and refuses new ones the same way. Waits up to {@link #STOP_GRACE} for their threads.
     */
    @Override
    public void close() {
        harness.close();
    }

    /**
     * One WARN per JVM when the Panama runner runs without native access enabled (JDK 22+ asks
     * {@code Module.isNativeAccessEnabled()}, read reflectively because the library compiles for Java 17); true when it
     * was logged now. It is a fact about Endive's Panama runner.
     * {@code enabled} is the module's state before the first runner was probed
     * ({@link ProviderSelector#nativeAccessBeforeSelection()}): the probe's own restricted call makes the JVM enable
     * native access for the module, after which the question always answers true (a check made after it
     * would never fire).
     */
    static boolean warnIfNativeAccessDisabled(Runner runner, Boolean enabled, AtomicBoolean warned) {
        if (runner != Runner.PANAMA || warned.get()) {
            return false;
        }
        if (Boolean.FALSE.equals(enabled) && warned.compareAndSet(false, true)) {
            LOG.warn("Datum: QuickJS runs on the Panama runner without native access enabled, so the JVM warns on its restricted "
                + "calls and a stricter JVM (--illegal-native-access=deny) refuses them. Add 'Enable-Native-Access: ALL-UNNAMED' "
                + "to the executable jar's manifest (Spring Boot's repackage keeps it), or start the JVM with "
                + "--enable-native-access=ALL-UNNAMED (spring-boot:run: jvmArguments or JAVA_TOOL_OPTIONS).");
            return true;
        }
        return false;
    }

    /** {@code module.isNativeAccessEnabled()} on JDK 21+, or null where the method does not exist. */
    static Boolean nativeAccessEnabled(Module module) {
        return ProviderSelector.nativeAccessEnabled(module);
    }

    /** Whether the Panama native-access WARN was logged in this JVM (tests). */
    static boolean nativeAccessWarned() {
        return NATIVE_ACCESS_WARNED.get();
    }

    /** Endive's half of a run, under the harness. */
    private final class Engine implements GuestEngine {

        @Override
        public EngineInfo info() {
            return engineInfo;
        }

        @Override
        public String where() {
            return "the " + selection.runner().id() + " runner";
        }

        @Override
        public void admit(GuestRun run, Budget budget) {
            // A budget below the module's own memory, refused before anything is made. Which programs may run on the
            // bytecode path is not this engine's to say: it reports its mode, and the Datum protocol refuses a PDF run
            // there before it reaches the harness (ProgramRunner.on).
            limits(budget);
        }

        @Override
        public Prepared prepare(GuestIo io, Budget budget) {
            MemoryLimits limits = limits(budget);
            WasiOptions options = WasiOptions.builder()
                .withArguments(io.argv())
                .withDirectory(GuestIo.GUEST_APP, io.app())
                .withRandom(io.random())
                .withClock(io.clock())
                // Pipes, as a wasmtime host gives them: QuickJS's own print flushes each line.
                .withStdin(io.stdin(), false)
                .withStdout(io.stdout(), false)
                .withStderr(io.stderr(), false)
                .build();
            WasiPreview1 wasi = WasiPreview1.builder().withOptions(options).build();
            ImportValues imports;
            try {
                imports = ImportValues.builder().addFunction(wasi.toHostFunctions()).build();
            } catch (RuntimeException | Error e) {
                wasi.close();
                throw e;
            }
            return new Prepared() {
                @Override
                public GuestEngine.Instance instantiate() {
                    List<Memory> made = new ArrayList<>(1);
                    // Endive's own Instance, named in full: inside this class the simple name is GuestEngine's.
                    run.endive.runtime.Instance.Builder builder = selection.builder()
                        .withImportValues(imports)
                        .withMemoryLimits(limits)
                        .withStart(false);
                    Runnable hook = beforeBuildForTests;
                    if (hook != null) {
                        hook.run();
                    }
                    return new Started(build(builder, made), made);
                }

                @Override
                public void close() {
                    wasi.close();
                }
            };
        }

        /**
         * {@code builder.build()}, with each native memory it makes remembered: when {@code build()} fails there is no
         * instance to close, so those memories are closed here before the failure goes on. The runner's own builder
         * makes them with the same {@code createMemory} its provider offers (both runners, Endive 1.1.0), so the
         * factory set here changes nothing but the bookkeeping. Bytecode memory is on the heap and needs none.
         */
        private run.endive.runtime.Instance build(run.endive.runtime.Instance.Builder builder, List<Memory> made) {
            NativeMachineFactoryProvider provider = selection.provider();
            if (provider != null) {
                builder.withMemoryFactory(memoryLimits -> {
                    Memory memory = provider.createMemory(memoryLimits);
                    made.add(memory);
                    unclosedMemories.incrementAndGet();
                    return memory;
                });
            }
            try {
                return builder.build();
            } catch (Throwable failure) {
                for (Memory memory : made) {
                    if (memory instanceof AutoCloseable closeable) {
                        try {
                            closeable.close();
                        } catch (Exception | LinkageError closing) {
                            failure.addSuppressed(closing);
                        }
                    }
                }
                unclosedMemories.addAndGet(-made.size());
                closedAfterFailedBuild.addAndGet(made.size());
                made.clear();
                throw failure;
            }
        }

        @Override
        public boolean interruptedBy(Throwable link) {
            // An interrupt that lands in the runner's set-up arrives as WasmEngineException("Failed to set up native
            // code") around this, hence the harness's walk of the causes.
            return link instanceof WasmInterruptedException;
        }

        @Override
        public boolean outOfHeap(Throwable link) {
            return endiveOutOfHeap(link);
        }

        @Override
        public Ending ended(Throwable failure) {
            if (failure instanceof StackGuard.OverrunException overrun) {
                return Ending.trap(overrun.getMessage());
            }
            if (failure instanceof WasiExitException exit) {
                return Ending.exited(exit.exitCode());
            }
            if (failure instanceof WasmEngineException) {
                // TrapException ("call stack exhausted", "unreachable"), WasmRuntimeException ("out of bounds memory
                // access"). QuickJS reports its own memory limit as an exit, never as an engine fault.
                return Ending.trap(failure.getClass().getSimpleName() + ": " + failure.getMessage());
            }
            return null;
        }
    }

    /** A built Endive instance; closing it frees its linear memory and settles the memory bookkeeping. */
    private final class Started implements GuestEngine.Instance {

        private final Instance instance;
        private final List<Memory> made;
        private boolean started;

        Started(Instance instance, List<Memory> made) {
            this.instance = instance;
            this.made = made;
        }

        /**
         * Arms the stack guard's canary, calls {@code _start}, and reads the canary and {@code .rodata} however it ended: a
         * run that reached the stack's floor ends as {@link StackGuard.OverrunException}, with how the guest then ended
         * kept as suppressed (never as the cause, so a stop or an exit cannot hide it).
         */
        @Override
        public void start() {
            started = true;
            Memory memory = instance.memory();
            stackGuard.arm(memory);
            try {
                instance.export("_start").apply();
            } catch (RuntimeException | StackOverflowError failure) {
                if (stackGuard.overran(memory)) {
                    StackGuard.OverrunException overrun = new StackGuard.OverrunException(StackGuard.OVERRUN + "; the guest then ended with "
                        + failure);
                    overrun.addSuppressed(failure);
                    throw overrun;
                }
                throw failure;
            }
            if (stackGuard.overran(memory)) {
                throw new StackGuard.OverrunException(StackGuard.OVERRUN + "; the guest then returned from _start");
            }
        }

        @Override
        public void close() {
            try {
                if (started) {
                    holdForTests();
                }
                instance.close();
            } finally {
                unclosedMemories.addAndGet(-made.size());
            }
        }

        private void holdForTests() {
            CountDownLatch hold = holdBeforeCloseForTests;
            if (hold == null) {
                return;
            }
            boolean waiting = true;
            while (waiting) {
                try {
                    hold.await();
                    waiting = false;
                } catch (InterruptedException ignored) {
                    // Ignored on purpose: this stands for an engine path that does not answer interrupts.
                }
            }
        }
    }
}
