package com.argusvane.datum.sandbox.protocol;

import com.argusvane.datum.core.ProgramUnavailableException;
import com.argusvane.datum.sandbox.wasi.Budget;
import com.argusvane.datum.sandbox.wasi.EngineInfo;
import com.argusvane.datum.sandbox.wasi.GuestRun;
import com.argusvane.datum.sandbox.wasi.GuestRuntime;
import com.argusvane.datum.sandbox.wasi.GuestUnavailableException;
import com.argusvane.datum.sandbox.wasi.RunOutput;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * Runs one Datum program over a generated {@code run.js}: what {@link SandboxService}, {@link PdfProgram} and the runtime's
 * pool ({@code DatumSandbox}) run through. The engine underneath is a {@link GuestRuntime}, which knows no program;
 * {@link #on(GuestRuntime)} is the one place a Datum run becomes a {@link GuestRun} ({@link #guestRun}) and the one place
 * what the engine refuses a run with becomes the protocol's own refusal.
 *
 * <p>Functional, so a test or a decorator can stand in with a lambda; a host runs the real engine through {@link #on}.
 */
@FunctionalInterface
public interface ProgramRunner {

    /** The name of the generated script under {@code /app}, the guest path {@code /app/run.js} that {@link RunScript#argv} names. */
    String RUN_SCRIPT = "run.js";

    /**
     * Runs one program.
     *
     * @param program the program evaluated with {@code -I}
     * @param runScript the {@code run.js} text ({@link RunScript})
     * @param argv the guest's arguments, {@code argv[0]} included ({@link RunScript#argv(Program.Kind)})
     * @param stdin everything the guest may read, handed over: not copied, so the caller does not change it afterwards
     * @param budget the run's limits
     * @return how the run ended and what it wrote
     * @throws ProgramUnavailableException (503 {@code server.unavailable}) when the run cannot start
     */
    RunOutput run(Program program, String runScript, List<String> argv, byte[] stdin, Budget budget);

    /**
     * A runner over an engine. Each run is built by {@link #guestRun}; a PDF run the engine cannot run ({@link
     * #canRunPdf(GuestRuntime)}: it runs the module as JVM bytecode, or its report cannot be read) is refused before
     * anything is run (a render that takes seconds natively would not finish in its budget, so a typed 503 rather than a
     * run that only times out; {@code PdfProgram} remembers it); and a {@link GuestUnavailableException} is answered as {@link ProgramUnavailableException} with the engine's
     * message, so a run that cannot start stays the runtime's outage. Every other outcome (a {@link RunOutput}, an
     * {@link IllegalArgumentException} for a budget the engine cannot honour, an {@link Error}) passes through unchanged.
     */
    static ProgramRunner on(GuestRuntime runtime) {
        return on(runtime, false);
    }

    /**
     * {@link #on(GuestRuntime)}, with every run asking the harness for its {@link com.argusvane.datum.sandbox.wasi.RunTimings}
     * when {@code timed}: what a host that traces or captures its runs makes, so a host that does
     * neither reads no clock per run.
     */
    static ProgramRunner on(GuestRuntime runtime, boolean timed) {
        Objects.requireNonNull(runtime, "runtime");
        return (program, runScript, argv, stdin, budget) -> {
            GuestRun run = guestRun(program, runScript, argv, stdin, budget, timed);
            if (program.kind() == Program.Kind.PDF && !canRunPdf(runtime)) {
                throw pdfRefusal(runtime);
            }
            try {
                return runtime.run(run);
            } catch (GuestUnavailableException e) {
                throw unavailable(e);
            }
        };
    }

    /**
     * The guest run of one program: under {@code /app}, the program's bytes as {@link Program.Kind#fileName()} (a read-only
     * view of exactly the bytes that were hashed and proved, never a copy that could drift) and then {@code run.js}
     * ({@link #RUN_SCRIPT}, the script's UTF-8), and nothing else; the arguments, stdin and budget as given.
     */
    static GuestRun guestRun(Program program, String runScript, List<String> argv, byte[] stdin, Budget budget) {
        return guestRun(program, runScript, argv, stdin, budget, false);
    }

    /** {@link #guestRun(Program, String, List, byte[], Budget)}, timed or not ({@link GuestRun#timed()}). */
    static GuestRun guestRun(Program program, String runScript, List<String> argv, byte[] stdin, Budget budget, boolean timed) {
        Objects.requireNonNull(program, "program");
        Objects.requireNonNull(runScript, "runScript");
        Objects.requireNonNull(argv, "argv");
        Objects.requireNonNull(stdin, "stdin");
        Objects.requireNonNull(budget, "budget");
        Map<String, ByteBuffer> files = new LinkedHashMap<>();
        files.put(program.kind().fileName(), program.buffer());
        files.put(RUN_SCRIPT, ByteBuffer.wrap(runScript.getBytes(StandardCharsets.UTF_8)));
        return new GuestRun(files, argv, ByteBuffer.wrap(stdin), budget, timed);
    }

    /** A run that could not start, as the protocol's 503: the engine's words, and the engine's refusal as the cause. */
    static ProgramUnavailableException unavailable(GuestUnavailableException failure) {
        return new ProgramUnavailableException(failure.getMessage(), failure);
    }

    /**
     * The one rule for whether the PDF program can run on an engine, shared by the runner's refusal, the lifecycle and
     * health: not on one that runs the module as JVM bytecode (a render that takes seconds natively would not finish in its
     * budget). An engine that reports {@link EngineInfo#UNKNOWN} is admitted, because an application's own runtime reports
     * exactly that by default; "no engine at all" is not decided here, it is the lifecycle's null delegate.
     */
    static boolean canRunPdf(EngineInfo engine) {
        return !engine.isBytecode();
    }

    /**
     * {@link #canRunPdf(EngineInfo)} for a runtime, asking its report: fail closed. A report that throws or answers null
     * cannot prove the engine is not the bytecode one, so the PDF program does not run on it (a wrapper must forward
     * {@link GuestRuntime#engineInfo()}).
     */
    static boolean canRunPdf(GuestRuntime runtime) {
        EngineInfo engine = reportOf(runtime);
        return engine != null && canRunPdf(engine);
    }

    /** The refusal of a PDF run: names the engine, its mode and its notes when it has them, or that the report is missing. */
    private static ProgramUnavailableException pdfRefusal(GuestRuntime runtime) {
        EngineInfo engine = reportOf(runtime);
        if (engine == null) {
            return new ProgramUnavailableException("The PDF program cannot run on the " + runtime.getClass().getName()
                + " runtime: its engineInfo() threw or answered nothing, so it cannot be shown not to be the bytecode engine "
                + "(a runtime that wraps another must forward engineInfo()).");
        }
        return new ProgramUnavailableException("The PDF program needs a native runner; the " + engine.id()
            + " engine runs QuickJS as JVM bytecode here (mode " + engine.mode() + ")."
            + (engine.notes().isEmpty() ? "" : " " + engine.notes()));
    }

    /** What the engine reports, or null when its report throws or answers nothing. */
    private static EngineInfo reportOf(GuestRuntime runtime) {
        try {
            return runtime.engineInfo();
        } catch (RuntimeException e) {
            return null;
        }
    }
}
