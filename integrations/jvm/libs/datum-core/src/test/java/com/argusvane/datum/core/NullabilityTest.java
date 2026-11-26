package com.argusvane.datum.core;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.core.hooks.HookProblem;
import java.io.File;
import java.lang.reflect.RecordComponent;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import org.jspecify.annotations.NullMarked;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.Test;

/**
 * Nullability: the SPI packages of datum-core are {@code @NullMarked} and carry
 * {@code @Nullable} where a null is meant, and the annotations cost the library nothing when JSpecify is not on the class path
 * (it is an optional dependency: an absent annotation class is ignored at run time).
 */
public class NullabilityTest {

    @Test
    void theSpiPackagesAreNullMarked() {
        for (Class<?> inPackage : List.of(HookProblem.class)) {
            Package spi = inPackage.getPackage();
            assertThat(spi.isAnnotationPresent(NullMarked.class)).as("%s is @NullMarked", spi.getName()).isTrue();
        }
    }

    @Test
    void aMemberThatMayBeNullSaysSoAndTheOthersDoNot() {
        RecordComponent[] components = HookProblem.class.getRecordComponents();
        for (RecordComponent component : components) {
            boolean nullable = component.getAnnotatedType().isAnnotationPresent(Nullable.class);
            assertThat(nullable).as(component.getName()).isEqualTo(!component.getName().equals("code"));
        }
    }

    /** Runs inside the isolated loader: the annotated classes in use with no JSpecify jar at all. */
    public static String withoutJspecify() {
        HookProblem problem = HookProblem.at(null, "tenant.prefix", null);
        return problem.code();
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
            assertThat(answer).isEqualTo("tenant.prefix");
        }
    }
}
