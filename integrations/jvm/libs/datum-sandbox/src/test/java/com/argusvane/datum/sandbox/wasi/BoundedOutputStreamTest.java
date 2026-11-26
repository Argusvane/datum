package com.argusvane.datum.sandbox.wasi;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.IOException;
import java.io.OutputStream;
import org.junit.jupiter.api.Test;

/** The output caps. */
class BoundedOutputStreamTest {

    @Test
    void theCapsAreThirtyTwoMebibytesAndSixtyFourKibibytes() {
        assertThat(Budget.STDOUT_LIMIT).isEqualTo(32L * 1024 * 1024);
        assertThat(Budget.STDOUT_LIMIT).isGreaterThan(20L * 1024 * 1024);
        assertThat(Budget.STDERR_LIMIT).isEqualTo(64L * 1024);
        // That a validation run is held to them is the protocol's: ProgramLimitsTest.aValidationRunIsHeldToTheOutputCaps.
    }

    @Test
    void exactlyTheCapIsAllowed() {
        BoundedOutputStream out = new BoundedOutputStream("stdout", 8);
        out.write(new byte[] {1, 2, 3, 4}, 0, 4);
        out.write(new byte[] {5, 6, 7, 8}, 0, 4);
        assertThat(out.exceeded()).isFalse();
        assertThat(out.toByteArray()).containsExactly(1, 2, 3, 4, 5, 6, 7, 8);
    }

    @Test
    void theWritePastTheCapThrowsAtOnceAndKeepsWhatFits() {
        BoundedOutputStream out = new BoundedOutputStream("stderr", 5);
        out.write(new byte[] {1, 2, 3}, 0, 3);
        assertThatThrownBy(() -> out.write(new byte[] {4, 5, 6}, 0, 3))
            .isInstanceOfSatisfying(OutputCapExceededException.class, e -> {
                assertThat(e.stream()).isEqualTo("stderr");
                assertThat(e.cap()).isEqualTo(5);
            });
        assertThat(out.exceeded()).isTrue();
        assertThat(out.toByteArray()).containsExactly(1, 2, 3, 4, 5);
        assertThat(out.size()).isEqualTo(5);
    }

    /** A runtime that swallowed the first throw cannot let the guest carry on writing. */
    @Test
    void everyWriteAfterTheCapThrowsAgain() {
        BoundedOutputStream out = new BoundedOutputStream("stdout", 1);
        assertThatThrownBy(() -> out.write(new byte[] {1, 2}, 0, 2)).isInstanceOf(OutputCapExceededException.class);
        assertThatThrownBy(() -> out.write(9)).isInstanceOf(OutputCapExceededException.class);
        assertThatThrownBy(() -> out.write(new byte[0], 0, 0)).isInstanceOf(OutputCapExceededException.class);
        assertThat(out.toByteArray()).containsExactly(1);
    }

    /** Unchecked, so a WASI layer that turns IOException into EIO cannot hand the guest an ignorable error. */
    @Test
    void theExceptionIsUnchecked() throws IOException {
        assertThat(RuntimeException.class).isAssignableFrom(OutputCapExceededException.class);
        try (OutputStream out = new BoundedOutputStream("stdout", 0)) {
            assertThatThrownBy(() -> out.write(1)).isInstanceOf(OutputCapExceededException.class);
        }
    }

    @Test
    void aBudgetIsAboveZero() {
        assertThatThrownBy(() -> new Budget(0, 1, 1, 1)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new Budget(1, 1, 0, 1)).isInstanceOf(IllegalArgumentException.class);
        // A cap past the longest array could never trigger: the buffer would fail first with an Error.
        assertThat(new Budget(1, 1, Budget.MAX_OUTPUT_CAP, 1).stdoutCap()).isEqualTo(Integer.MAX_VALUE - 8);
        assertThatThrownBy(() -> new Budget(1, 1, Budget.MAX_OUTPUT_CAP + 1, 1)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new Budget(1, 1, 1, 4096L * 1024 * 1024)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new BoundedOutputStream("stdout", Budget.MAX_OUTPUT_CAP + 1)).isInstanceOf(IllegalArgumentException.class);
    }
}
