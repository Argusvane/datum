package com.argusvane.datum.sandbox.endive;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import com.argusvane.datum.core.ProgramUnavailableException;
import com.argusvane.datum.sandbox.protocol.ProgramRunner;
import com.argusvane.datum.sandbox.wasi.EngineInfo;
import com.argusvane.datum.sandbox.wasi.GuestRuntimeProvider;
import com.argusvane.datum.sandbox.wasi.Budget;
import com.argusvane.datum.sandbox.wasi.RunOutput;
import com.argusvane.datum.sandbox.wasi.Termination;
import com.argusvane.datum.sandbox.tck.RuntimeTckAssets;
import java.nio.charset.StandardCharsets;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * The bytecode path, in a JVM where the generated class finds no native code: {@code -Dendive.redline.os.arch=riscv64}
 * (the bytecode-fallback surefire execution). The runtime says "bytecode" and still runs QuickJS.
 */
class BytecodeFallbackTest {

    @Test
    void noNativeCodeRunsAsBytecodeAndSaysSo() {
        assumeTrue("riscv64".equals(System.getProperty("endive.redline.os.arch")), "only in the bytecode-fallback execution");
        assertThat(Qjs.loadNativeCode()).isNull();
        ProviderSelector.Selection selection = ProviderSelector.select();
        assertThat(selection.runner()).isEqualTo(Runner.BYTECODE);
        assertThat(selection.reason()).contains("riscv64");
        try (EndiveGuestRuntime runtime = new EndiveGuestRuntime()) {
            assertThat(runtime.nativeProvider()).isEqualTo("bytecode");
            assertThat(runtime.isNative()).isFalse();
            assertThat(runtime.info().isNative()).isFalse();
            // What health, info and the ready event see: the bytecode mode, no PDF, and why.
            assertThat(runtime.engineInfo().mode()).isEqualTo(EngineInfo.BYTECODE);
            assertThat(runtime.engineInfo().isBytecode()).as("bytecode, so the lifecycle runs no PDF program here").isTrue();
            assertThat(runtime.engineInfo().notes()).contains("JVM bytecode").contains("riscv64").contains("datum-sandbox-endive-jffi");
            GuestRuntimeProvider.Availability availability = new EndiveRuntimeProvider().availability();
            assertThat(availability.isAvailable()).as("the bytecode fallback is available, slower").isTrue();
            assertThat(((GuestRuntimeProvider.Available) availability).notes()).contains("bytecode").contains("PDF program is unavailable");
            RunOutput output = runtime.run(ProgramRunner.guestRun(RuntimeTckAssets.sandboxProgram(), "print(6 * 7);\n", List.of("qjs", "--std", "/app/run.js"),
                new byte[0], new Budget(30, 32L << 20, Budget.STDOUT_LIMIT, Budget.STDERR_LIMIT)));
            assertThat(output.termination()).isEqualTo(Termination.EXITED);
            assertThat(output.exitCode()).isZero();
            assertThat(new String(output.stdout(), StandardCharsets.UTF_8)).isEqualTo("42\n");
            // The PDF path is unavailable on bytecode: a typed 503 before any run.
            // The refusal is the protocol's (ProgramRunner.on), from the engine's mode: Endive itself runs no program.
            assertThatThrownBy(() -> ProgramRunner.on(runtime).run(RuntimeTckAssets.pdfProgram(), "print(1);", List.of("qjs", "--std", "/app/run.js"),
                new byte[0], new Budget(30, 256L << 20, 256L << 20, Budget.STDERR_LIMIT)))
                .isInstanceOf(ProgramUnavailableException.class).hasMessageContaining("native");
        }
    }

    /**
     * The JVM running out of heap mid-run is the host's capacity, not the guest's budget: on
     * bytecode the linear memory lives on the heap, so a guest well inside its own 2 GiB limit fills this fork's small
     * heap (the bytecode-fallback execution runs with -Xmx384m). The run must come back as the host's interruption,
     * with what it wrote, never as MEMORY (which a check reads as definition.tooCostly); and the next run answers.
     */
    @Test
    void theJvmOutOfHeapIsTheHostsStopNotTheGuests() {
        assumeTrue("riscv64".equals(System.getProperty("endive.redline.os.arch")), "only in the bytecode-fallback execution");
        assumeTrue(Runtime.getRuntime().maxMemory() <= (512L << 20), "only with the execution's small heap");
        try (EndiveGuestRuntime runtime = new EndiveGuestRuntime()) {
            RunOutput output = runtime.run(ProgramRunner.guestRun(RuntimeTckAssets.sandboxProgram(),
                "print('@@started@@'); var a = []; for (;;) { a.push(new ArrayBuffer(1 << 20)); }",
                List.of("qjs", "--std", "/app/run.js"), new byte[0], new Budget(120, 2L << 30, Budget.STDOUT_LIMIT, Budget.STDERR_LIMIT)));
            assertThat(output.termination()).as(String.valueOf(output.trapMessage())).isEqualTo(Termination.INTERRUPTED);
            assertThat(output.trapMessage()).contains("heap");
            assertThat(new String(output.stdout(), StandardCharsets.UTF_8)).isEqualTo("@@started@@\n");
            RunOutput next = runtime.run(ProgramRunner.guestRun(RuntimeTckAssets.sandboxProgram(), "print(1);", List.of("qjs", "--std", "/app/run.js"),
                new byte[0], new Budget(30, 32L << 20, Budget.STDOUT_LIMIT, Budget.STDERR_LIMIT)));
            assertThat(next.exitCode()).as("the next run answers").isZero();
        }
    }
}
