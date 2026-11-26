package com.argusvane.datum.sandbox.runtime;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.sandbox.protocol.HostOptions;
import com.argusvane.datum.sandbox.protocol.ProgramLimits;
import com.argusvane.datum.sandbox.protocol.RunLog;
import com.argusvane.datum.sandbox.spring.DatumSandboxLifecycle;
import java.time.Duration;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.context.SmartLifecycle;

/**
 * The Spring lifecycle adapter over the plain runtime, with the assertions it always had. Same package as the library test so it
 * can build the runtime from the library's test helpers (datum-sandbox-test-support).
 */
class DatumSandboxLifecycleTest {

    private final TestRuntime engine = new TestRuntime();
    private DatumSandbox runtime;

    @AfterEach
    void tearDown() {
        if (runtime != null) {
            runtime.stop();
        }
    }

    private DatumSandbox runtime(boolean failFast) {
        runtime = DatumSandbox.builder().runtime(engine).store(Programs.packaged().store()).limits(ProgramLimits.defaults()).hostOptions(HostOptions.defaults())
            .settings(TestSettings.of("endive", failFast, 2, Duration.ofSeconds(1), 1, Duration.ZERO)).events(event -> { }).runLog(RunLog.slf4j()).build();
        return runtime;
    }

    @Test
    void itStartsBeforeAndStopsAfterTheWebServer() {
        // WebServerStartStopLifecycle is DEFAULT_PHASE - 2048, graceful shutdown DEFAULT_PHASE - 1024; Spring stops
        // the highest phase first.
        // The runtime is a plain class; the Spring lifecycle adapter carries the phase.
        DatumSandboxLifecycle lifecycle =
            new DatumSandboxLifecycle(runtime(true));
        assertThat(lifecycle.getPhase()).isLessThan(SmartLifecycle.DEFAULT_PHASE - 2048);
        assertThat(lifecycle.isAutoStartup()).isTrue();
        assertThat(lifecycle.isRunning()).isFalse();
        lifecycle.start();
        assertThat(lifecycle.isRunning()).isTrue().isEqualTo(runtime.isRunning());
        lifecycle.stop();
        assertThat(runtime.isRunning()).isFalse();
    }

}
