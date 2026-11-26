package com.argusvane.datum.sandbox;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.core.LibraryBoundaryRules;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;

/**
 * The library packages of datum-sandbox name no framework, no binding package and no JDBC, and the module holds no binding: the one
 * rule is {@link LibraryBoundaryRules} (datum-core-test-support), run here with this module's name. On top of it the layering: the sandbox sits on datum-core and datum-programs only. It names no datum-web-core, datum-forms,
 * datum-submissions, datum-ui, datum-pdf, datum-timestamp or datum-webauthn package, no Spring and no Jakarta type, so any
 * capability, and any framework binding, can sit on it without a cycle. And the hardened WASI layer
 * ({@code sandbox.wasi}) names no Datum type outside itself and imports nothing but the JDK, SLF4J, JSpecify and Jimfs, so the
 * run's guarantees cannot come to depend on the protocol above them.
 */
class LibraryBoundaryTest extends LibraryBoundaryRules {

    /** The packages of the modules above the sandbox: none of them is named from here. */
    private static final List<String> ABOVE = List.of("web", "forms", "submissions", "ui", "pdf", "timestamp", "webauthn");

    LibraryBoundaryTest() {
        super("datum-sandbox");
    }

    @Test
    void theSandboxNamesNoModuleAboveItAndNoSpringOrJakartaType() throws IOException {
        List<String> found = new ArrayList<>();
        for (Path source : librarySources()) {
            String code = code(Files.readString(source));
            String name = SOURCES.relativize(source).toString();
            for (String above : ABOVE) {
                if (Pattern.compile("(?<![\\w.])com\\.argusvane\\.datum\\." + above + "\\.").matcher(code).find()) {
                    found.add(name + " names the " + above + " packages");
                }
            }
            for (String prefix : List.of("org.springframework.", "jakarta.", "javax.")) {
                if (Pattern.compile("(?<![\\w.])" + Pattern.quote(prefix)).matcher(code).find()) {
                    found.add(name + " names " + prefix + "*");
                }
            }
        }
        assertThat(found).as("what the sandbox must not name").isEmpty();
    }

    /** The wasi layer's sources, main and test: the layer and its own tests stand without the protocol above. */
    private static final List<Path> WASI = List.of(SOURCES.resolve("com/argusvane/datum/sandbox/wasi"),
        Path.of("src/test/java/com/argusvane/datum/sandbox/wasi"));

    /** What a wasi source may import: the JDK, SLF4J, JSpecify, Jimfs and the layer itself. */
    private static final List<String> WASI_IMPORTS = List.of("java.", "javax.", "jdk.", "org.slf4j.", "org.jspecify.",
        "com.google.common.jimfs.", "com.google.jimfs.", "com.argusvane.datum.sandbox.wasi.");

    /** What a wasi test may import besides: JUnit and AssertJ. */
    private static final List<String> WASI_TEST_IMPORTS = List.of("org.junit.", "org.assertj.");

    private static final Pattern IMPORT = Pattern.compile("(?m)^\\s*import\\s+(?:static\\s+)?([\\w.]+(?:\\.\\*)?)\\s*;");

    private static final Pattern DATUM_NAME = Pattern.compile("(?<![\\w.])com\\.argusvane\\.datum\\.[\\w.]+");

    @Test
    void theWasiLayerNamesNoDatumTypeOutsideItselfAndImportsOnlyTheJdkSlf4jJspecifyAndJimfs() throws IOException {
        List<String> found = new ArrayList<>();
        int sources = 0;
        for (Path root : WASI) {
            boolean test = root.startsWith("src/test");
            try (Stream<Path> files = Files.walk(root)) {
                for (Path source : files.filter(file -> file.toString().endsWith(".java")).toList()) {
                    sources++;
                    found.addAll(wasiViolations(source.toString(), Files.readString(source), test));
                }
            }
        }
        assertThat(sources).as("the wasi sources were found").isGreaterThan(20);
        assertThat(found).as("what the wasi layer must not name").isEmpty();
    }

    @Test
    void theWasiRuleSeesWhatItLooksFor() {
        assertThat(wasiViolations("A.java", "package com.argusvane.datum.sandbox.wasi;\nimport com.argusvane.datum.sandbox.protocol.Program;\n", false))
            .singleElement().asString().contains("imports com.argusvane.datum.sandbox.protocol.Program");
        assertThat(wasiViolations("A.java", "import com.argusvane.datum.core.*;\nclass A {}", false)).isNotEmpty();
        assertThat(wasiViolations("A.java", "import static com.argusvane.datum.core.X.y;\nclass A {}", false)).isNotEmpty();
        assertThat(wasiViolations("A.java", "class A { com.argusvane.datum.core.ProgramUnavailableException e; }", false))
            .singleElement().asString().contains("names com.argusvane.datum.core.ProgramUnavailableException");
        assertThat(wasiViolations("A.java", "import tools.jackson.databind.JsonNode;\nclass A {}", false)).isNotEmpty();
        assertThat(wasiViolations("A.java", "import org.junit.jupiter.api.Test;\nclass A {}", false)).isNotEmpty();
        assertThat(wasiViolations("A.java", "import org.junit.jupiter.api.Test;\nclass A {}", true)).isEmpty();
        // A javadoc link or a string is not a use; the layer's own types and the allowed libraries are fine.
        assertThat(wasiViolations("A.java", "import java.util.List;\nimport org.slf4j.Logger;\nimport org.jspecify.annotations.Nullable;\n"
            + "import com.google.common.jimfs.Jimfs;\nimport com.argusvane.datum.sandbox.wasi.GuestRun;\n"
            + "/** {@link com.argusvane.datum.core.ProgramUnavailableException} */ class A { String s = \"com.argusvane.datum.core.X\"; }", false))
            .isEmpty();
    }

    /** What one wasi source names that it must not: an import outside the allowed prefixes, or a Datum type outside the layer. */
    private static List<String> wasiViolations(String name, String text, boolean test) {
        List<String> found = new ArrayList<>();
        String code = code(text);
        Matcher imports = IMPORT.matcher(code);
        while (imports.find()) {
            String imported = imports.group(1);
            boolean allowed = WASI_IMPORTS.stream().anyMatch(imported::startsWith)
                || test && WASI_TEST_IMPORTS.stream().anyMatch(imported::startsWith);
            if (!allowed) {
                found.add(name + " imports " + imported);
            }
        }
        Matcher datum = DATUM_NAME.matcher(IMPORT.matcher(code).replaceAll(""));
        while (datum.find()) {
            String named = datum.group();
            if (!named.equals("com.argusvane.datum.sandbox.wasi") && !named.startsWith("com.argusvane.datum.sandbox.wasi.")) {
                found.add(name + " names " + named);
            }
        }
        return found;
    }
}
