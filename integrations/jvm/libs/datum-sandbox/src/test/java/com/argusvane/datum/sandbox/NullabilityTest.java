package com.argusvane.datum.sandbox;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.sandbox.protocol.SandboxException;
import com.argusvane.datum.sandbox.wasi.EngineInfo;
import java.io.File;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import org.jspecify.annotations.NullMarked;
import org.junit.jupiter.api.Test;

/**
 * The SPI packages of the sandbox
 * are {@code @NullMarked}, and the library runs with JSpecify (an optional dependency) absent from the class path.
 */
public class NullabilityTest {

    @Test
    void theSpiPackagesAreNullMarked() {
        for (Class<?> inPackage : List.of(SandboxException.class, EngineInfo.class)) {
            Package spi = inPackage.getPackage();
            assertThat(spi.isAnnotationPresent(NullMarked.class)).as("%s is @NullMarked", spi.getName()).isTrue();
        }
    }

    /** Runs inside the isolated loader: the annotated classes in use with no JSpecify jar at all. */
    public static String withoutJspecify() {
        SandboxException failure = new SandboxException(SandboxException.Reason.BUSY, "busy");
        return failure.reason() + "/" + failure.typedCode();
    }

    @Test
    void theLibraryRunsWithoutJspecifyOnTheClassPath() throws Exception {
        String path = System.getProperty("surefire.test.class.path", System.getProperty("java.class.path"));
        List<URL> urls = new ArrayList<>();
        for (String entry : path.split(File.pathSeparator)) {
            if (!entry.isBlank() && !entry.contains("jspecify")) {
                urls.add(Path.of(entry).toUri().toURL());
            }
        }
        try (URLClassLoader isolated = new URLClassLoader(urls.toArray(URL[]::new), ClassLoader.getPlatformClassLoader())) {
            assertThatThrownBy(() -> isolated.loadClass("org.jspecify.annotations.Nullable"))
                .as("the loader really has no JSpecify").isInstanceOf(ClassNotFoundException.class);
            Object answer = isolated.loadClass(NullabilityTest.class.getName()).getMethod("withoutJspecify").invoke(null);
            assertThat(answer).isEqualTo("BUSY/null");
        }
    }
}
