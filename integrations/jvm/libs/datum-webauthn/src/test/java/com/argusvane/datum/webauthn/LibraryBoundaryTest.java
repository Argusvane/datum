package com.argusvane.datum.webauthn;

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
 * The library packages of datum-webauthn name no framework, no binding package and no JDBC, and the module holds no binding: the one
 * rule is {@link LibraryBoundaryRules} (datum-core-test-support), run here with this module's name.
 *
 * <p>Beyond that, the root package imports no Datum module but datum-core, and the receiver seam
 * ({@code .submissions}) only datum-submissions' SPI besides.
 */
class LibraryBoundaryTest extends LibraryBoundaryRules {

    LibraryBoundaryTest() {
        super("datum-webauthn");
    }

    private static final Path ROOT = Path.of("src/main/java/com/argusvane/datum/webauthn");

    private static List<String> imports(Path dir, boolean recurse) throws IOException {
        try (Stream<Path> files = recurse ? Files.walk(dir) : Files.list(dir)) {
            return files.filter(file -> file.toString().endsWith(".java")).flatMap(file -> {
                try {
                    return Files.readAllLines(file).stream().filter(line -> line.startsWith("import ")).map(line -> file.getFileName() + ": " + line);
                } catch (IOException e) {
                    throw new java.io.UncheckedIOException(e);
                }
            }).toList();
        }
    }

    /** The root package imports no other Datum module but datum-core. */
    @Test
    void theRootPackageImportsNoSpringAndNoOtherDatumModule() throws IOException {
        assertThat(Files.isDirectory(ROOT)).isTrue();
        List<String> imports = imports(ROOT, false);
        assertThat(imports).isNotEmpty();
        assertThat(imports).noneMatch(line -> line.contains("org.springframework"));
        assertThat(imports).filteredOn(line -> line.contains("com.argusvane.datum."))
            .allMatch(line -> line.contains("com.argusvane.datum.core.") || line.contains("com.argusvane.datum.webauthn."));
    }

    /** The receiver seam ({@code .submissions}) imports only datum-submissions' SPI besides. */
    @Test
    void theSeamImportsOnlyTheSubmissionsSpi() throws IOException {
        List<String> imports = imports(ROOT.resolve("submissions"), true);
        assertThat(imports).noneMatch(line -> line.contains("org.springframework"));
        assertThat(imports).filteredOn(line -> line.contains("com.argusvane.datum.submissions."))
            .allMatch(line -> line.contains("com.argusvane.datum.submissions.spi."));
    }

}
