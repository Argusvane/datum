package com.argusvane.datum.sandbox.endive;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.Test;

/**
 * The Panama runner without native access enabled gets one WARN naming the fix, and no other runner gets it (it is a fact about Endive's Panama runner).
 */
class NativeAccessWarningTest {

    @Test
    void aPanamaRunnerWithoutNativeAccessGetsOneWarning() {
        Module module = NativeAccessWarningTest.class.getModule();
        Boolean enabled = EndiveGuestRuntime.nativeAccessEnabled(module);
        // Module.isNativeAccessEnabled() is there from JDK 21 (Temurin 21 answered false on CI);
        // JDK 22 is where the JVM warns instead of refusing. Before 21 there is no method.
        if (Runtime.version().feature() < 21) {
            assertThat(enabled).isNull();
        }
        AtomicBoolean warned = new AtomicBoolean();
        assertThat(EndiveGuestRuntime.warnIfNativeAccessDisabled(Runner.PANAMA, enabled, warned)).isEqualTo(Boolean.FALSE.equals(enabled));
        assertThat(warned.get()).isEqualTo(Boolean.FALSE.equals(enabled));
        assertThat(EndiveGuestRuntime.warnIfNativeAccessDisabled(Runner.PANAMA, enabled, warned)).as("once, not again").isFalse();
        assertThat(warned.get()).isEqualTo(Boolean.FALSE.equals(enabled));
        AtomicBoolean fresh = new AtomicBoolean();
        assertThat(EndiveGuestRuntime.warnIfNativeAccessDisabled(Runner.PANAMA, false, fresh)).as("access off: the WARN").isTrue();
        assertThat(EndiveGuestRuntime.warnIfNativeAccessDisabled(Runner.PANAMA, true, new AtomicBoolean())).as("access on: none").isFalse();
        assertThat(EndiveGuestRuntime.warnIfNativeAccessDisabled(Runner.PANAMA, null, new AtomicBoolean())).as("before JDK 21: none").isFalse();
    }

    @Test
    void noOtherRunnerIsWarnedAbout() {
        AtomicBoolean warned = new AtomicBoolean();
        assertThat(EndiveGuestRuntime.warnIfNativeAccessDisabled(Runner.JFFI, false, warned)).isFalse();
        assertThat(EndiveGuestRuntime.warnIfNativeAccessDisabled(Runner.BYTECODE, false, warned)).isFalse();
        assertThat(warned.get()).isFalse();
    }
}
