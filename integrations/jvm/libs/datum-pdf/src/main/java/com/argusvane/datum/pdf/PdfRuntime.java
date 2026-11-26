package com.argusvane.datum.pdf;

import com.argusvane.datum.core.ProgramUnavailableException;
import com.argusvane.datum.sandbox.wasi.EngineInfo;
import com.argusvane.datum.sandbox.protocol.ProgramRunner;
import com.argusvane.datum.sandbox.protocol.HostOptions;
import com.argusvane.datum.sandbox.protocol.PdfKernel;
import com.argusvane.datum.sandbox.protocol.ProgramLimits;
import com.argusvane.datum.sandbox.protocol.RunSlots;
import com.argusvane.datum.sandbox.runtime.DatumSandbox;
import java.util.Map;
import java.util.Objects;

/**
 * What {@link PdfService} needs of the programs' runtime: the PDF program (gated by its ABI), the PDF slots, what the
 * engine reports about itself (whether it can run the PDF program here), the host's context keys and the PDF
 * time budget. Framework-free, so a second host binding
 * supplies its own; {@link #of(DatumSandbox)} adapts the datum-sandbox runtime and its PDF slots.
 */
public interface PdfRuntime {

    /**
     * The PDF program, while it can be run: the kernel the runtime built and its decorators wrapped, so a
     * decorator there sees every run this service makes.
     *
     * @throws ProgramUnavailableException when it cannot (runtime down, program missing or stale)
     */
    PdfKernel program();

    /** The PDF slots: at most so many PDF runs at once ({@code datum.runtime.pdf.concurrency}, {@code .wait}). */
    RunSlots slots();

    /**
     * What the engine reports about itself: its id and its mode ({@code panama}, {@code jffi}, {@code bytecode},
     * {@code unknown}, {@code none}), from which {@link #permanentlyUnavailable()} decides whether the PDF program can run here.
     */
    EngineInfo engine();

    /** The keys the host decides for a run ({@code today}, {@code formulaErrors}, {@code riskyPatterns}). */
    Map<String, String> contextKeys();

    /** The time one PDF run may take, whole seconds: how long the second half of a seal waits for a slot. */
    int pdfSeconds();

    /**
     * Why PDFs can never be made on this platform, or null when they can (or only cannot right now). A permanent
     * platform fact is not an outage: the bytecode runner cannot run the PDF program, and a build may ship none.
     * Health reports it UP with {@code available:false} and the reason, never DOWN, because DOWN would make a
     * readiness probe restart a pod for ever on a platform without a native target.
     * The default is the runtime's decision from the engine's mode ({@link ProgramRunner#canRunPdf}: not on bytecode) and
     * names only the engine's id and mode: the
     * notes can carry a passed-over runner's exception text (a native library's file path), and this reason is the
     * PDF health's {@code reason}.
     */
    default String permanentlyUnavailable() {
        EngineInfo engine = engine();
        return ProgramRunner.canRunPdf(engine) ? null : "The PDF program cannot run on the " + engine.id() + " engine here (mode "
            + engine.mode() + ").";
    }

    /** The sandbox runtime, asked afresh on every call (a recheck may swap the program). */
    static PdfRuntime of(DatumSandbox runtime) {
        Objects.requireNonNull(runtime, "runtime");
        return new PdfRuntime() {
            @Override
            public PdfKernel program() {
                return runtime.pdfProgram();
            }

            @Override
            public RunSlots slots() {
                return runtime.pdfSlots();
            }

            @Override
            public EngineInfo engine() {
                return runtime.engineInfo();
            }

            @Override
            public Map<String, String> contextKeys() {
                return runtime.hostOptions().contextKeys();
            }

            @Override
            public int pdfSeconds() {
                return runtime.limits().pdfSeconds();
            }

            @Override
            public String permanentlyUnavailable() {
                com.argusvane.datum.sandbox.runtime.SandboxStatus status = runtime.status();
                // Up, yet the PDF program is not usable: the runner cannot run it or the build ships none.
                if (status.state() == com.argusvane.datum.sandbox.runtime.SandboxStatus.State.UP && status.pdfUnavailable() != null) {
                    return status.pdfUnavailable();
                }
                // An engine that cannot run the PDF program here is a permanent fact only while the runtime is up: after a failed recheck the
                // runtime is down, which is an outage and must show as DOWN, not as a settled available:false.
                return status.state() == com.argusvane.datum.sandbox.runtime.SandboxStatus.State.UP
                    ? PdfRuntime.super.permanentlyUnavailable() : null;
            }
        };
    }

    /**
     * A runtime whose program is wrapped by {@code decorate}: how a binding that lets an application replace the
     * {@link PdfRuntime} still applies the host's {@code PdfKernelDecorator} chain to it, so a replacement can never skip the
     * decorators. Everything but {@link #program()} is the delegate's. The wrapped kernel is kept while the delegate answers the
     * same kernel, so a decorator is applied once per kernel, not on every call.
     */
    static PdfRuntime decorating(PdfRuntime delegate, java.util.function.UnaryOperator<PdfKernel> decorate) {
        Objects.requireNonNull(delegate, "delegate");
        Objects.requireNonNull(decorate, "decorate");
        java.util.concurrent.atomic.AtomicReference<PdfKernel[]> last = new java.util.concurrent.atomic.AtomicReference<>();
        return new PdfRuntime() {
            @Override
            public PdfKernel program() {
                PdfKernel kernel = delegate.program();
                PdfKernel[] seen = last.get();
                if (seen != null && seen[0] == kernel) {
                    return seen[1];
                }
                PdfKernel wrapped = Objects.requireNonNull(decorate.apply(kernel), "a PdfKernelDecorator answered null");
                last.set(new PdfKernel[] {kernel, wrapped});
                return wrapped;
            }

            @Override
            public RunSlots slots() {
                return delegate.slots();
            }

            @Override
            public EngineInfo engine() {
                return delegate.engine();
            }

            @Override
            public Map<String, String> contextKeys() {
                return delegate.contextKeys();
            }

            @Override
            public int pdfSeconds() {
                return delegate.pdfSeconds();
            }

            @Override
            public String permanentlyUnavailable() {
                return delegate.permanentlyUnavailable();
            }
        };
    }

    /** A fixed program and slots (tests, a host without the sandbox's lifecycle). */
    static PdfRuntime of(PdfKernel program, RunSlots slots, EngineInfo engine, HostOptions hostOptions, ProgramLimits limits) {
        Objects.requireNonNull(program, "program");
        Objects.requireNonNull(slots, "slots");
        Objects.requireNonNull(engine, "engine");
        Objects.requireNonNull(hostOptions, "hostOptions");
        Objects.requireNonNull(limits, "limits");
        return new PdfRuntime() {
            @Override
            public PdfKernel program() {
                return program;
            }

            @Override
            public RunSlots slots() {
                return slots;
            }

            @Override
            public EngineInfo engine() {
                return engine;
            }

            @Override
            public Map<String, String> contextKeys() {
                return hostOptions.contextKeys();
            }

            @Override
            public int pdfSeconds() {
                return limits.pdfSeconds();
            }
        };
    }
}
