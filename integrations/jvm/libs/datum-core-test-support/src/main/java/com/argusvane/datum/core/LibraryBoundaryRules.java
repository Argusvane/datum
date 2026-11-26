package com.argusvane.datum.core;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;

/**
 * The one library-boundary rule every library module runs (shared so that no module's copy can drift). A module's {@code LibraryBoundaryTest} extends this class with its artifact id and adds only
 * what is its own; this class lives in datum-core-test-support, which is never published.
 *
 * <p>The library packages of a module name no framework (integrations/jvm/README.md "Libraries and bindings"; the timestamp module's test generalised): no Spring, Quarkus, Jakarta REST, CDI, Vert.x,
 * servlet, Reactor, springdoc, SmallRye or MicroProfile type, imported or written out in full, and no class of a binding package of any
 * Datum module. A binding package is one with a {@code spring}, {@code mvc}, {@code webflux} or
 * {@code autoconfigure} segment: the Spring adapters, in the {@code -spring} modules.
 * Everything else in {@code src/main/java} is library and must work on any host.
 */
public abstract class LibraryBoundaryRules {

    /** The module's main sources, relative to the module directory Maven runs the tests in. */
    protected static final Path SOURCES = Path.of("src/main/java");

    private final String module;

    /** @param module the artifact id, for the failure messages (for example {@code datum-forms}) */
    protected LibraryBoundaryRules(String module) {
        this.module = module;
    }

    private static final List<String> FORBIDDEN = List.of("org.springframework.", "io.quarkus.", "jakarta.ws.rs.",
        "jakarta.enterprise.", "io.vertx.", "jakarta.servlet.", "reactor.", "org.springdoc.", "io.smallrye.",
        "org.eclipse.microprofile.");

    private static final Set<String> BINDING_SEGMENTS = Set.of("spring", "mvc", "webflux", "autoconfigure");

    private static final Pattern DATUM_TYPE = Pattern.compile("com\\.argusvane\\.datum\\.[a-z0-9_.]+");

    /** Whether a package (or a type's full name) lies in a binding package. */
    protected static boolean binding(String name) {
        String rest = name.startsWith("com.argusvane.datum.") ? name.substring("com.argusvane.datum.".length()) : name;
        for (String segment : rest.split("\\.")) {
            if (BINDING_SEGMENTS.contains(segment)) {
                return true;
            }
        }
        return false;
    }

    protected static List<Path> librarySources() throws IOException {
        try (Stream<Path> files = Files.walk(SOURCES)) {
            return files.filter(file -> file.toString().endsWith(".java"))
                .filter(file -> !binding(SOURCES.relativize(file.getParent()).toString().replace('/', '.').replace('\\', '.')))
                .toList();
        }
    }

    /** The code without comments and string literals: a type named in a javadoc or a string is not a use. */
    protected static String code(String source) {
        StringBuilder out = new StringBuilder(source.length());
        int i = 0;
        while (i < source.length()) {
            char c = source.charAt(i);
            if (c == '/' && i + 1 < source.length() && source.charAt(i + 1) == '/') {
                while (i < source.length() && source.charAt(i) != '\n') {
                    i++;
                }
            } else if (c == '/' && i + 1 < source.length() && source.charAt(i + 1) == '*') {
                int end = source.indexOf("*/", i + 2);
                i = end < 0 ? source.length() : end + 2;
                out.append(' ');
            } else if (c == '"' && source.startsWith("\"\"\"", i)) {
                int end = source.indexOf("\"\"\"", i + 3);
                i = end < 0 ? source.length() : end + 3;
                out.append("\"\"");
            } else if (c == '"' || c == '\'') {
                char quote = c;
                i++;
                while (i < source.length() && source.charAt(i) != quote) {
                    i += source.charAt(i) == '\\' ? 2 : 1;
                }
                i++;
                out.append(quote).append(quote);
            } else {
                out.append(c);
                i++;
            }
        }
        return out.toString();
    }

    @Test
    public void theLibraryPackagesNameNoFrameworkAndNoBindingPackage() throws IOException {
        List<Path> sources = librarySources();
        assertThat(sources).as("library sources of " + module).isNotEmpty();
        List<String> found = new ArrayList<>();
        for (Path source : sources) {
            String code;
            String text;
            try {
                text = Files.readString(source);
                code = code(text);
            } catch (IOException e) {
                throw new UncheckedIOException(e);
            }
            String name = SOURCES.relativize(source).toString();
            for (String prefix : FORBIDDEN) {
                if (Pattern.compile("(?<![\\w.])" + Pattern.quote(prefix)).matcher(code).find()) {
                    found.add(name + " names " + prefix + "*");
                }
            }
            // A class name written as a string (an @AutoConfiguration beforeName, a @ConditionalOnClass name) is
            // still framework wiring: it belongs to the binding (the -spring module).
            for (String literal : strings(text)) {
                for (String prefix : FORBIDDEN) {
                    if (literal.startsWith(prefix)) {
                        found.add(name + " writes the class name \"" + literal + "\"");
                    }
                }
                if (DATUM_TYPE.matcher(literal).matches() && binding(literal)) {
                    found.add(name + " writes the binding type \"" + literal + "\"");
                }
            }
            Matcher datum = DATUM_TYPE.matcher(code);
            while (datum.find()) {
                if (binding(datum.group())) {
                    found.add(name + " names the binding type " + datum.group());
                }
            }
        }
        assertThat(found).as("framework types in the library packages of " + module).isEmpty();
    }

    /**
     * No SQL in the library (framework-first): the SQL stores are the bindings' (datum-*-spring on Spring's
     * JdbcClient and TransactionTemplate; a Quarkus binding would write its own), so no library source names
     * {@code java.sql} or {@code javax.sql}. Every library holds this rule, including those with no store, so none
     * gains one unseen.
     */
    @Test
    public void theLibraryPackagesHoldNoJdbc() throws IOException {
        List<String> found = new ArrayList<>();
        for (Path source : librarySources()) {
            String code = code(Files.readString(source));
            for (String prefix : List.of("java.sql.", "javax.sql.")) {
                if (Pattern.compile("(?<![\\w.])" + Pattern.quote(prefix)).matcher(code).find()) {
                    found.add(SOURCES.relativize(source) + " names " + prefix + "*");
                }
            }
        }
        assertThat(found).as("JDBC in the library packages of " + module).isEmpty();
    }

    /** The string literals of a source, outside comments (text blocks included, char literals not). */
    protected static List<String> strings(String source) {
        List<String> out = new ArrayList<>();
        int i = 0;
        while (i < source.length()) {
            char c = source.charAt(i);
            if (c == '/' && i + 1 < source.length() && source.charAt(i + 1) == '/') {
                while (i < source.length() && source.charAt(i) != '\n') {
                    i++;
                }
            } else if (c == '/' && i + 1 < source.length() && source.charAt(i + 1) == '*') {
                int end = source.indexOf("*/", i + 2);
                i = end < 0 ? source.length() : end + 2;
            } else if (c == '"' && source.startsWith("\"\"\"", i)) {
                int end = source.indexOf("\"\"\"", i + 3);
                out.add(source.substring(i + 3, end < 0 ? source.length() : end).strip());
                i = end < 0 ? source.length() : end + 3;
            } else if (c == '"' || c == '\'') {
                char quote = c;
                int from = ++i;
                while (i < source.length() && source.charAt(i) != quote) {
                    i += source.charAt(i) == '\\' ? 2 : 1;
                }
                if (quote == '"') {
                    out.add(source.substring(from, Math.min(i, source.length())));
                }
                i++;
            } else {
                i++;
            }
        }
        return out;
    }

    @Test
    public void theScannerSeesWhatItLooksFor() {
        assertThat(strings("// \"org.a\"\n/* \"org.b\" */ String s = \"org.springdoc.A\"; char q = '\"'; String t = \"x\\\"y\";"))
            .containsExactly("org.springdoc.A", "x\\\"y");
        assertThat(binding("com.argusvane.datum.forms.spring.DatumFormsAutoConfiguration")).isTrue();
        assertThat(binding("com.argusvane.datum.forms.web.mvc.DefinitionMvcController")).isTrue();
        assertThat(binding("com.argusvane.datum.springweb.autoconfigure")).isTrue();
        assertThat(binding("com.argusvane.datum.web.error.ErrorMapper")).isFalse();
        assertThat(binding("com.argusvane.datum.forms.web.FormsApi")).isFalse();
        assertThat(code("import org.springframework.x; // org.springdoc\n/* reactor. */ String s = \"io.quarkus.y\";"))
            .contains("org.springframework.").doesNotContain("org.springdoc").doesNotContain("reactor.").doesNotContain("io.quarkus");
    }

    /**
     * A library module holds no binding at all: no package with a binding segment, no
     * auto-configuration class and no Spring imports file. Those are the module's {@code -spring} binding's (under
     * integrations/jvm/spring), so a Quarkus binding can depend on this jar and nothing Spring-shaped comes with it.
     */
    @Test
    public void theModuleHoldsNoBinding() throws IOException {
        List<String> found = new ArrayList<>();
        try (Stream<Path> files = Files.walk(SOURCES)) {
            files.filter(file -> file.toString().endsWith(".java")).forEach(file -> {
                String name = SOURCES.relativize(file).toString().replace('\\', '/');
                if (binding(SOURCES.relativize(file.getParent()).toString().replace('/', '.').replace('\\', '.'))) {
                    found.add(name + " is in a binding package");
                }
                if (file.getFileName().toString().endsWith("AutoConfiguration.java")) {
                    found.add(name + " is an auto-configuration");
                }
            });
        }
        if (Files.exists(Path.of("src/main/resources/META-INF/spring"))) {
            found.add("src/main/resources/META-INF/spring holds Spring wiring");
        }
        assertThat(found).as("binding code in a library module").isEmpty();
    }
}
