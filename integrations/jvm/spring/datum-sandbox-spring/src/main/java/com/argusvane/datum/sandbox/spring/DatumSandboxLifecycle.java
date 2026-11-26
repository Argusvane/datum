package com.argusvane.datum.sandbox.spring;

import com.argusvane.datum.sandbox.runtime.DatumSandbox;
import java.util.Objects;
import org.springframework.context.SmartLifecycle;

/**
 * The Spring lifecycle of the framework-free {@link DatumSandbox} (integrations/jvm/README.md "Libraries and bindings"): start, stop and running are the runtime's own.
 *
 * <p>The phase is not the highest one: Spring stops the highest phase first, so
 * a runtime meant to stop after the web server has stopped taking requests (and has finished the in-flight ones
 * under graceful shutdown) needs a phase below the web server's lifecycles. {@link #PHASE} is below both
 * ({@code WebServerStartStopLifecycle} and {@code WebServerGracefulShutdownLifecycle}), which also proves the
 * programs before the server takes its first request.
 */
public final class DatumSandboxLifecycle implements SmartLifecycle {

    /**
     * Below the web server's lifecycles ({@code DEFAULT_PHASE - 1024} and {@code - 2048}): started before the
     * server takes requests, stopped after it stopped taking them and finished the ones in flight.
     */
    public static final int PHASE = SmartLifecycle.DEFAULT_PHASE - 4096;

    private final DatumSandbox runtime;

    public DatumSandboxLifecycle(DatumSandbox runtime) {
        this.runtime = Objects.requireNonNull(runtime, "runtime");
    }

    /** The runtime it starts and stops. */
    public DatumSandbox runtime() {
        return runtime;
    }

    @Override
    public void start() {
        runtime.start();
    }

    @Override
    public void stop() {
        runtime.stop();
    }

    @Override
    public boolean isRunning() {
        return runtime.isRunning();
    }

    @Override
    public int getPhase() {
        return PHASE;
    }
}
