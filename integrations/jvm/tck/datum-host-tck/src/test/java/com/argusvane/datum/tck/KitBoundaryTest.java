package com.argusvane.datum.tck;

import static org.assertj.core.api.Assertions.assertThat;

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
 * The kit judges a host by its answers only (integrations/jvm/README.md "Libraries and bindings"): it names no
 * framework a binding is written in and no Datum library, so a Quarkus binding could run it unchanged and a binding
 * can never pass by sharing code with the kit. The libraries' LibraryBoundaryTest with one rule more: every Datum type
 * it names is its own ({@code com.argusvane.datum.tck}).
 */
class KitBoundaryTest {

    private static final Path SOURCES = Path.of("src/main/java");

    private static final List<String> FORBIDDEN = List.of("org.springframework.", "io.quarkus.", "jakarta.ws.rs.",
        "jakarta.enterprise.", "io.vertx.", "jakarta.servlet.", "reactor.", "org.springdoc.", "io.smallrye.",
        "org.eclipse.microprofile.");

    private static final Pattern DATUM_TYPE = Pattern.compile("com\\.argusvane\\.datum\\.[A-Za-z0-9_.$]+");

    /** The code without comments; string literals kept, because a class name in a string is a use too. */
    static String withoutComments(String source) {
        return source.replaceAll("(?s)/\\*.*?\\*/", " ").replaceAll("(?m)//[^\\n]*$", " ");
    }

    static List<String> findings(String name, String source) {
        String code = withoutComments(source);
        List<String> found = new ArrayList<>();
        for (String prefix : FORBIDDEN) {
            if (Pattern.compile("(?<![\\w.])" + Pattern.quote(prefix)).matcher(code).find()) {
                found.add(name + " names " + prefix + "*");
            }
        }
        Matcher datum = DATUM_TYPE.matcher(code);
        while (datum.find()) {
            if (!datum.group().startsWith("com.argusvane.datum.tck")) {
                found.add(name + " names the Datum type " + datum.group());
            }
        }
        return found;
    }

    @Test
    void theKitNamesNoFrameworkAndNoDatumLibrary() throws IOException {
        List<String> found = new ArrayList<>();
        int files = 0;
        try (Stream<Path> walk = Files.walk(SOURCES)) {
            for (Path file : walk.filter(path -> path.toString().endsWith(".java")).toList()) {
                files++;
                found.addAll(findings(SOURCES.relativize(file).toString(), Files.readString(file)));
            }
        }
        assertThat(files).isGreaterThan(10);
        assertThat(found).as("framework or Datum library types in the kit").isEmpty();
    }

    @Test
    void theScannerSeesWhatItLooksFor() {
        assertThat(findings("A", "import com.argusvane.datum.web.error.ErrorMapper;")).hasSize(1);
        assertThat(findings("A", "String s = \"org.springframework.web.Foo\";")).hasSize(1);
        assertThat(findings("A", "import org.eclipse.microprofile.config.Config;")).hasSize(1);
        assertThat(findings("A", "// org.springframework.x\n/* io.quarkus.y */ import com.argusvane.datum.tck.Reply;")).isEmpty();
    }
}
