package com.argusvane.datum.sandbox.endive;

/**
 * What runs the precompiled QuickJS: one of Endive's two Redline native runners, or the JVM bytecode the same class
 * carries for platforms without native code.
 */
public enum Runner {
    /** {@code redline-runner-experimental}: the Foreign Function and Memory API, Java 25+ (class-file version 69). */
    PANAMA("panama", "run.endive.redline.experimental.runner.PanamaMachineFactoryProvider"),
    /** {@code redline-runner-jffi-experimental}: jffi, Java 17+. */
    JFFI("jffi", "run.endive.redline.experimental.runner.jffi.JffiMachineFactoryProvider"),
    /**
     * No native runner: QuickJS as JVM bytecode ({@code Qjs.safeBuilder()}), its memory on the heap. Validation is
     * several times slower and the PDF program is too slow to use.
     */
    BYTECODE("bytecode", null);

    private final String id;
    private final String providerClass;

    Runner(String id, String providerClass) {
        this.id = id;
        this.providerClass = providerClass;
    }

    /** The name health and info report: "panama", "jffi" or "bytecode". */
    public String id() {
        return id;
    }

    /** The runner's {@code NativeMachineFactoryProvider} class, or {@code null} for {@link #BYTECODE}. */
    public String providerClass() {
        return providerClass;
    }

    /** Whether QuickJS runs as native code. */
    public boolean isNative() {
        return this != BYTECODE;
    }
}
