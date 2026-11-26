package com.argusvane.datum.timestamp;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.core.LibraryBoundaryRules;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;

/**
 * The library packages of datum-timestamp name no framework, no binding package and no JDBC, and the module holds no binding: the one
 * rule is {@link LibraryBoundaryRules} (datum-core-test-support), run here with this module's name.
 *
 * <p>Beyond that, the RFC 3161 library in the root package (not its web sub-package) works
 * without the Datum runtime: it may use datum-core (DatumException, Jcs), Bouncy Castle and the JDK only.
 */
class LibraryBoundaryTest extends LibraryBoundaryRules {

    LibraryBoundaryTest() {
        super("datum-timestamp");
    }

    /** The RFC 3161 root package uses datum-core, Bouncy Castle and the JDK only. */
    @Test
    void theRootPackageImportsNoSpringAndNoDatumModuleButCore() throws IOException {
        Path root = Path.of("src/main/java/com/argusvane/datum/timestamp");
        List<Path> sources;
        try (Stream<Path> files = Files.list(root)) {
            sources = files.filter(p -> p.toString().endsWith(".java")).toList();
        }
        assertThat(sources).isNotEmpty();
        for (Path source : sources) {
            for (String line : Files.readAllLines(source)) {
                if (!line.startsWith("import ")) {
                    continue;
                }
                assertThat(line).as(source.getFileName().toString()).doesNotContain("org.springframework");
                if (line.contains("com.argusvane.datum.")) {
                    assertThat(line).as(source.getFileName().toString()).contains("com.argusvane.datum.core.");
                }
            }
        }
    }

}
