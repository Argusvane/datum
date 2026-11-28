package com.argusvane.datum.sandbox.protocol;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.core.observation.DatumObservation;
import com.argusvane.datum.core.observation.DatumObservations;
import com.argusvane.datum.sandbox.observation.GuestRunObservations;
import java.io.File;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * {@code micrometer-observation} is an optional dependency of the libraries: with it off the
 * class path, the protocol, the decorators and {@link DatumObservations#none()} load and run, and only the Micrometer
 * adapter fails to load. Proved in a class loader over this module's test class path without any Micrometer jar.
 */
public class OptionalMicrometerTest {

    /** Runs inside the isolated loader: everything a host without Micrometer touches. */
    public static String withoutMicrometer() throws Exception {
        Program program = Program.of(Program.Kind.SANDBOX, "/* program */".getBytes(StandardCharsets.UTF_8));
        SandboxService service = new SandboxService(FakeRuntime.answering("{\"errors\":[]}"), program, new RunScript("/* f */"),
            ProgramLimits.defaults(), HostOptions.defaults(), new RunSlots(1, Duration.ZERO, "validation", () -> { }), new AbiProbe(),
            RunLog.slf4j(), null);
        Sandbox sandbox = SandboxDecorator.compose(List.of(GuestRunObservations.sandbox(DatumObservations.none(), "test"))).decorate(service);
        sandbox.proveAbi();
        sandbox.validate((tools.jackson.databind.node.ObjectNode) StrictJson.decode("{\"formId\":\"f\",\"form\":{\"id\":\"root\","
            + "\"type\":\"form\",\"configuration\":{},\"children\":{\"content\":[]}},\"values\":{},\"locale\":\"en\"}"), List.of(), false);
        try (DatumObservation observation = DatumObservations.none().start("datum.submission", "datum submission", "mode", "submit")) {
            observation.lowCardinality("outcome", DatumObservations.outcomeOf(new IllegalStateException()));
        }
        return sandbox == service ? "unwrapped" : "wrapped";
    }

    @Test
    void theProtocolTheDecoratorsAndNoObservationsRunWithoutMicrometer() throws Exception {
        String path = System.getProperty("surefire.test.class.path", System.getProperty("java.class.path"));
        List<URL> urls = new ArrayList<>();
        for (String entry : path.split(File.pathSeparator)) {
            if (!entry.isBlank() && !entry.contains("micrometer")) {
                urls.add(Path.of(entry).toUri().toURL());
            }
        }
        try (URLClassLoader isolated = new URLClassLoader(urls.toArray(URL[]::new), ClassLoader.getPlatformClassLoader())) {
            assertThatThrownBy(() -> isolated.loadClass("io.micrometer.observation.ObservationRegistry"))
                .as("the loader really has no Micrometer").isInstanceOf(ClassNotFoundException.class);
            Object answer = isolated.loadClass(OptionalMicrometerTest.class.getName()).getMethod("withoutMicrometer").invoke(null);
            assertThat(answer).as("with no observations the sandbox is the protocol itself").isEqualTo("unwrapped");
            // A class that implements a Micrometer type cannot even load there: the libraries never touch those two.
            assertThatThrownBy(() -> Class.forName("com.argusvane.datum.core.observation.DatumObservationDocumentation", true, isolated))
                .as("the Micrometer-typed classes need Micrometer").isInstanceOf(NoClassDefFoundError.class);
        }
    }
}
