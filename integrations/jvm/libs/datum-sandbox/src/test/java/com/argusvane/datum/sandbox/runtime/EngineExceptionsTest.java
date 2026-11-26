package com.argusvane.datum.sandbox.runtime;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.core.DatumConfigurationException;
import com.argusvane.datum.core.RecordCopies;
import com.argusvane.datum.sandbox.wasi.EngineInfo;
import com.argusvane.datum.sandbox.wasi.EngineSettings;
import org.junit.jupiter.api.Test;

/**
 * The engine refusals: the start
 * refusal says what is wrong and what to do, as separate statements.
 */
class EngineExceptionsTest {

    @Test
    void theMemoryFloorRefusalCarriesTheNumbersAndTheProperty() {
        EngineMemoryFloorException refusal = new EngineMemoryFloorException("datum.runtime.pdf.memory", "PDF", 1024, 8_388_608, "QuickJS module");
        assertThat(refusal).isInstanceOf(DatumConfigurationException.class);
        assertThat(refusal.bytes()).isEqualTo(1024);
        assertThat(refusal.least()).isEqualTo(8_388_608);
        assertThat(refusal.getMessage()).contains("PDF memory budget (1024 bytes)").contains("8388608");
        assertThat(refusal.action()).contains("datum.runtime.pdf.memory").contains("8388608");
    }

    @Test
    void theBytecodeRefusalNamesTheAllowanceTheEnginesReasonAndBothFixes() {
        EngineInfo bytecode = new EngineInfo("endive", "1.1.0", EngineInfo.BYTECODE,
            "QuickJS runs as JVM bytecode on Linux/riscv64 (Java 25): the jar has no Redline native code for Linux/riscv64 (Java 25).");
        EngineBytecodeException refusal = new EngineBytecodeException("datum.runtime.allow-bytecode", bytecode);
        assertThat(refusal).isInstanceOf(DatumConfigurationException.class);
        assertThat(refusal.property()).isEqualTo("datum.runtime.allow-bytecode");
        assertThat(refusal.engine()).isSameAs(bytecode);
        assertThat(refusal.getMessage()).isEqualTo("The endive engine would run the programs as JVM bytecode on this platform, and "
            + "datum.runtime.allow-bytecode is false, so Datum does not start (on bytecode, validation is several times slower and the PDF "
            + "program cannot run). The engine says: QuickJS runs as JVM bytecode on Linux/riscv64 (Java 25): the jar has no Redline native "
            + "code for Linux/riscv64 (Java 25).");
        assertThat(refusal.action()).isEqualTo("Run on a platform the engine has native code for, with a native runner it can use (the "
            + "engine's words above name what is missing), or set datum.runtime.allow-bytecode=true to start on bytecode anyway (validation "
            + "runs, slower, and the PDF routes answer 503).");
        // An engine that says nothing more, and a host with no property name: still one problem and one action.
        EngineBytecodeException bare = new EngineBytecodeException(null, new EngineInfo("mine", null, EngineInfo.BYTECODE, " "));
        assertThat(bare.getMessage()).contains("The mine engine").contains("running on bytecode is not allowed").doesNotContain("The engine says");
        assertThat(bare.action()).contains("allow running on bytecode");
        // A note without a closing stop gets one, so the problem reads as sentences.
        assertThat(new EngineBytecodeException("p", new EngineInfo("x", null, EngineInfo.BYTECODE, "no native code")).getMessage())
            .endsWith("The engine says: no native code.");
    }

    @Test
    void onlyABytecodeEngineIsRefused() {
        assertThatThrownBy(() -> new EngineBytecodeException("p", new EngineInfo("x", null, "jffi", "")))
            .isInstanceOf(IllegalArgumentException.class).isNotInstanceOf(DatumConfigurationException.class);
    }

    @Test
    void theEngineSettingsCopiesKeepEveryOtherComponent() throws ReflectiveOperationException {
        assertThat(RecordCopies.assertCopies(EngineSettings.defaults())).isEqualTo(2);
    }
}
