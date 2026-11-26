package com.argusvane.datum.sandbox.runtime;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.sandbox.protocol.PdfKernelDecorator;
import com.argusvane.datum.sandbox.protocol.SandboxDecorator;
import com.argusvane.datum.sandbox.wasi.EngineLimits;
import com.argusvane.datum.sandbox.wasi.EngineSettings;
import com.argusvane.datum.sandbox.wasi.GuestRun;
import com.argusvane.datum.sandbox.wasi.GuestRuntime;
import com.argusvane.datum.sandbox.wasi.GuestRuntimeProvider;
import com.argusvane.datum.sandbox.wasi.RunOutput;
import java.io.IOException;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The engine a sandbox selects itself (no runtime handed to the builder): it is closed exactly once however often the sandbox is
 * closed, and a build refused for a bad input never creates one to leak. The engine is a counting provider that a class loader
 * lists in {@code META-INF/services}, the route a plain-Java host's class path takes.
 */
class DatumSandboxOwnedEngineTest {

    /** Counts every engine made and every close. */
    static final AtomicInteger CREATED = new AtomicInteger();
    static final AtomicInteger CLOSED = new AtomicInteger();

    /** The provider the service file lists; public with a public constructor for {@code ServiceLoader}. */
    public static final class CountingProvider implements GuestRuntimeProvider {

        @Override
        public String id() {
            return "counting";
        }

        @Override
        public Availability availability() {
            return Availability.available("test");
        }

        @Override
        public GuestRuntime create(EngineLimits limits, EngineSettings settings) {
            CREATED.incrementAndGet();
            return new CountingRuntime();
        }
    }

    static final class CountingRuntime implements GuestRuntime, AutoCloseable {

        @Override
        public RunOutput run(GuestRun run) {
            throw new UnsupportedOperationException("the tests start nothing");
        }

        @Override
        public void close() {
            CLOSED.incrementAndGet();
        }
    }

    private URLClassLoader loader;

    @BeforeEach
    void listTheProvider(@TempDir Path dir) throws IOException {
        CREATED.set(0);
        CLOSED.set(0);
        Path services = Files.createDirectories(dir.resolve("META-INF/services"));
        Files.writeString(services.resolve(GuestRuntimeProvider.class.getName()), CountingProvider.class.getName() + "\n",
            StandardCharsets.UTF_8);
        loader = new URLClassLoader(new URL[] {dir.toUri().toURL()}, getClass().getClassLoader());
    }

    @AfterEach
    void closeTheLoader() throws IOException {
        loader.close();
    }

    private DatumSandbox.Builder selecting() {
        return DatumSandbox.builder().settings(SandboxSettings.builder().engine("counting").build()).classLoader(loader);
    }

    @Test
    void theEngineTheSandboxSelectedIsClosedOnceHoweverOftenTheSandboxIs() {
        DatumSandbox sandbox = selecting().build();
        assertThat(CREATED).hasValue(1);
        sandbox.close();
        sandbox.close();
        sandbox.close();
        assertThat(CLOSED).as("one engine, one close").hasValue(1);
    }

    @Test
    void anEngineACallerHandedInIsNeverClosed() {
        DatumSandbox sandbox = DatumSandbox.builder().runtime(new CountingRuntime()).build();
        sandbox.close();
        sandbox.close();
        assertThat(CLOSED).hasValue(0);
    }

    @Test
    @SuppressWarnings("NullAway")
    void aNullDecoratorListOrObservationsIsRefusedBeforeAnyEngineIsMade() {
        assertThatThrownBy(() -> selecting().sandboxDecorators(null)).isInstanceOf(NullPointerException.class);
        assertThatThrownBy(() -> selecting().pdfKernelDecorators(null)).isInstanceOf(NullPointerException.class);
        assertThatThrownBy(() -> selecting().observations(null)).isInstanceOf(NullPointerException.class);
        assertThat(CREATED).hasValue(0);
    }

    @Test
    void aNullElementInADecoratorListIsRefusedBeforeTheEngineIsMade() {
        assertThatThrownBy(() -> selecting().sandboxDecorators(Arrays.asList((SandboxDecorator) null)).build())
            .isInstanceOf(NullPointerException.class);
        assertThatThrownBy(() -> selecting().pdfKernelDecorators(Arrays.asList((PdfKernelDecorator) null)).build())
            .isInstanceOf(NullPointerException.class);
        assertThat(CREATED).as("no engine was made for a build that could not finish").hasValue(0);
        assertThat(CLOSED).hasValue(0);
    }
}
