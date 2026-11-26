package com.argusvane.datum.sandbox.wasi;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.ByteBuffer;
import java.nio.ReadOnlyBufferException;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Test;

/**
 * The layer's refusals and the limits an engine is created with: one unchecked root that the
 * layer above translates, and nothing here a configuration or HTTP type.
 */
class WasiTypesTest {

    @Test
    void everyRefusalOfTheLayerIsAnUncheckedWasiException() {
        assertThat(new GuestUnavailableException("down")).isInstanceOf(WasiException.class).isInstanceOf(RuntimeException.class)
            .isNotInstanceOf(IllegalArgumentException.class);
        assertThat(new EngineConfigurationException("no")).isInstanceOf(WasiException.class);
        assertThat(new MemoryFloorException(1, 2, "module")).isInstanceOf(EngineConfigurationException.class)
            .isNotInstanceOf(IllegalArgumentException.class);
        assertThat(WasiException.class).isAssignableFrom(EngineSelectionException.class);
        Throwable cause = new LinkageError("no native library");
        assertThat(new GuestUnavailableException("down", cause)).hasCause(cause).hasMessage("down");
        // The cap's stop is not a refusal: it is thrown through the guest's write and read as OUTPUT_CAP.
        assertThat(WasiException.class.isAssignableFrom(OutputCapExceededException.class)).isFalse();
    }

    @Test
    void theMemoryFloorSaysWhatWasAskedWhatIsNeededAndWhatNeedsIt() {
        MemoryFloorException floor = new MemoryFloorException(1024, 8_388_608, "QuickJS module");
        assertThat(floor.bytes()).isEqualTo(1024);
        assertThat(floor.least()).isEqualTo(8_388_608);
        assertThat(floor.engine()).isEqualTo("QuickJS module");
        assertThat(floor.getMessage()).contains("1024 bytes").contains("QuickJS module's initial memory, 8388608 bytes")
            .doesNotContain("datum.");
    }

    @Test
    void theEngineLimitsAreAboveZeroAndInOrder() {
        EngineLimits limits = new EngineLimits(4L << 20, 256L << 20);
        assertThat(limits.minMemoryBytes()).isEqualTo(4L << 20);
        assertThat(limits.maxMemoryBytes()).isEqualTo(256L << 20);
        assertThat(new EngineLimits(1, 1).maxMemoryBytes()).isEqualTo(1);
        assertThatThrownBy(() -> new EngineLimits(0, 1)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new EngineLimits(2, 1)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void anUnreportedEngineIsNothingKnownAndSoNotBytecode() {
        EngineInfo unreported = EngineInfo.unreported("com.example.Mine");
        assertThat(unreported.id()).isEqualTo("com.example.Mine");
        assertThat(unreported.mode()).isEqualTo(EngineInfo.UNKNOWN);
        assertThat(unreported.isBytecode()).isFalse();
        assertThat(EngineInfo.class.getRecordComponents()).extracting(component -> component.getName())
            .as("what an engine says, never what may run on it").containsExactly("id", "version", "mode", "notes");
    }

    /** The protocol reads the output through views, not copies of up to the cap on every run. */
    @Test
    void theOutputViewsAreReadOnlyAndSayWhatWasWritten() {
        RunOutput output = RunOutput.exited(0, "out".getBytes(StandardCharsets.UTF_8), "err!".getBytes(StandardCharsets.UTF_8));
        ByteBuffer stdout = output.stdoutView();
        ByteBuffer stderr = output.stderrView();
        assertThat(stdout.isReadOnly()).isTrue();
        assertThat(stderr.isReadOnly()).isTrue();
        assertThat(stdout.position()).isZero();
        assertThat(stdout.limit()).isEqualTo(output.stdoutLength()).isEqualTo(3);
        assertThat(stderr.limit()).isEqualTo(output.stderrLength()).isEqualTo(4);
        assertThat(StandardCharsets.UTF_8.decode(stdout).toString()).isEqualTo("out");
        assertThatThrownBy(() -> output.stdoutView().put(0, (byte) 'x')).isInstanceOf(ReadOnlyBufferException.class);
        // Each call is a fresh view; a read of one does not move another, and the record's bytes stay as written.
        assertThat(output.stdoutView().position()).isZero();
        assertThat(output.stdout()).containsExactly('o', 'u', 't');
        assertThat(RunOutput.exited(0, null, null).stdoutView().limit()).isZero();
    }
}
