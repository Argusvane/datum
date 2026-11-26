package com.argusvane.datum.sandbox.runtime;

import com.argusvane.datum.core.DatumConfigurationException;
import com.argusvane.datum.sandbox.wasi.EngineInfo;
import java.util.Objects;
import org.jspecify.annotations.Nullable;

/**
 * The engine would run the programs as JVM bytecode here ({@link EngineInfo#isBytecode()}: no native code for this
 * platform, or no native runner it can use) and the host has not allowed that, so the host refuses to start rather than
 * judge every submission several times slower with no PDF program. The refusal is the lifecycle's ({@link DatumSandbox#start()}
 * throws it before any program is proved, whatever fail-fast says), made on the
 * {@link EngineInfo} any engine reports, so an application's own runtime that says {@code bytecode} is held exactly as
 * Endive's fallback is. A {@link DatumConfigurationException} naming the allowance's property, which is what a host
 * prints: the problem with the engine's own words on why (Endive's name the platform and the runners passed over), and
 * the two fixes.
 *
 * <p>The engine's notes are in the problem because the operator needs them to fix the platform; they are operator text
 * for the start-up log and never a secret ({@link EngineInfo}), but a host keeps them out of anything a read answers, as
 * it does the notes themselves.
 */
public final class EngineBytecodeException extends DatumConfigurationException {

    private static final long serialVersionUID = 1L;

    private final transient EngineInfo engine;

    /**
     * @param property the allowance's property ({@code datum.runtime.allow-bytecode}), or null for a host that names none
     * @param engine   what the engine reports; its mode is {@link EngineInfo#BYTECODE}
     * @throws IllegalArgumentException (not this type) for an engine that is not on bytecode: nothing to refuse
     */
    public EngineBytecodeException(@Nullable String property, EngineInfo engine) {
        super(property, problem(property, engine), action(property));
        this.engine = engine;
    }

    /** What the engine reported (null after deserialization). */
    public EngineInfo engine() {
        return engine;
    }

    private static String problem(@Nullable String property, EngineInfo engine) {
        Objects.requireNonNull(engine, "engine");
        if (!engine.isBytecode()) {
            throw new IllegalArgumentException("The " + engine.id() + " engine runs in mode " + engine.mode() + ", not bytecode.");
        }
        String notes = engine.notes().strip();
        return "The " + engine.id() + " engine would run the programs as JVM bytecode on this platform, and "
            + (property == null ? "running on bytecode is not allowed" : property + " is false")
            + ", so Datum does not start (on bytecode, validation is several times slower and the PDF program cannot run)."
            + (notes.isEmpty() ? "" : " The engine says: " + notes + (notes.endsWith(".") ? "" : "."));
    }

    private static String action(@Nullable String property) {
        return "Run on a platform the engine has native code for, with a native runner it can use (the engine's words above name what "
            + "is missing), or " + (property == null ? "allow running on bytecode" : "set " + property + "=true")
            + " to start on bytecode anyway (validation runs, slower, and the PDF routes answer 503).";
    }
}
