package com.argusvane.datum.timestamp.spring;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
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
 * datum-timestamp-spring is a binding and nothing more (integrations/jvm/README.md "Libraries and bindings"):
 * every class lies in a binding package ({@code spring}, {@code mvc}, {@code webflux} or {@code autoconfigure}
 * segment), the module carries no Datum resources of its own (assets, programs and migrations are the library's), the
 * MVC and WebFlux adapters shape no JSON (the facade does; the shared body readers of datum-spring-web are the one
 * allowance), and no binding class decides an answer: none writes a wire code, picks a status, or makes a refusal of
 * its own. Logic found here would have to be copied by a Quarkus binding, which is the defect this test exists to
 * catch. The auto-configurations and {@code @ConfigurationProperties} classes are wiring and are left out of the last
 * rule (their throws are start-up configuration errors; their dotted strings are property keys and class names).
 * Every copy of this test in the seven Spring binding modules is the same apart from the module name.
 * Framework-first rule: the SQL stores ({@code Jdbc*} classes in a {@code spring} package,
 * library SPIs written on Spring's JdbcClient and TransactionTemplate) are wiring too, not adapters: their underscored
 * strings are table names and they throw the SPI's own exceptions (a duplicate passkey, a missing generated id), so
 * they are held only to the narrower {@link #storeDecisions} rule: no dotted or one-word wire code, no status, and no
 * refusal of its own (an exception it builds is one of {@link #STORE_EXCEPTIONS}; anything else it throws is a caught
 * exception or one a library class made). A refusal with a wire code stays the library's
 * ({@code PasskeyRepository.unstorable()}); the store rule does not let a refusal built from a code
 * constant and a bare status through.
 * Framework-first rule: an {@code InMemory*} class in a {@code spring} package, the single-instance
 * development default of a library SPI (the submission throttle, the TSA flood counter), is held to the same store rule
 * (it may also throw {@code IllegalArgumentException} for a bad constructor value); it is still no place for a wire code or
 * a status.
 */
class BindingBoundaryTest {

    private static final Path SOURCES = Path.of("src/main/java");

    private static final Set<String> BINDING_SEGMENTS = Set.of("spring", "mvc", "webflux", "autoconfigure");

    /** The shared request-body readers (one per web stack: Spring MVC and WebFlux) may read JSON. */
    private static final Set<String> BODY_READERS = Set.of("com/argusvane/datum/springweb/mvc/MvcBodies.java",
        "com/argusvane/datum/springweb/webflux/WebFluxBodies.java");

    /**
     * Binding classes that may write a status: the WebFlux handler mapping that answers the 405 the binding's
     * {@code DatumMethodRules} decided (method set and {@code Allow} from the rules, matched with Spring's
     * {@code PathPattern}), the counterpart of Spring MVC's own 405, which reaches {@code ErrorMapper.forStatus}
     * through the advice.
     */
    private static final Set<String> STATUS_WRITERS = Set.of("com/argusvane/datum/springweb/webflux/DatumMethodNotAllowedMapping.java");

    /**
     * A string shaped like a Datum wire code: dotted ({@code form.notFound}, {@code passkey.bad_request}),
     * underscored ({@code bad_document}, {@code method_not_allowed}), or one of the one-word codes. A dotted Java class
     * name (last segment capitalised) is not a code.
     */
    private static final Pattern WIRE_CODE = Pattern.compile("\"([a-z]+(?:\\.[a-zA-Z_]+)+|[a-z]+(?:_[a-z]+)+)\"");

    private static final Set<String> ONE_WORD_CODES = Set.of("required", "flood", "internal", "forbidden", "unauthorized",
        "throttled", "busy");

    private static final Pattern STRING = Pattern.compile("\"((?:[^\"\\\\]|\\\\.)*)\"");

    /** A status chosen in the binding: a literal in a status call, a named HttpStatus other than OK, a shortcut builder. */
    private static final Pattern STATUS = Pattern.compile(
        "(?:\\.status|HttpStatusCode\\s*\\.\\s*valueOf|setStatus(?:Code)?|ResponseStatusException)\\s*\\(([^;]*?\\b[1-5]\\d\\d\\b[^;]*?)\\)"
            + "|HttpStatus\\s*\\.\\s*(?!OK\\b)[A-Z][A-Z_]+"
            + "|(?:ResponseEntity|ServerResponse)\\s*\\.\\s*(?!ok\\b|status\\b)[a-z]\\w*\\s*\\(");

    /** A refusal: what a {@code throw} or a {@code Mono.error}/{@code Flux.error} carries. */
    private static final Pattern REFUSAL = Pattern.compile("\\bthrow\\s+([^;]+);|\\b(?:Mono|Flux)\\s*\\.\\s*error\\s*\\(([^;]+)\\)\\s*;");

    /**
     * What a binding may throw: an I/O failure, a caught exception passed on, or a refusal a library class made
     * ({@code api.fileTooLarge()}, {@code JsonBodies.tooLarge(cap)}). Not a {@code new} refusal, and not one from a
     * helper of its own.
     */
    /** An exception built in the binding, wherever it goes (thrown, {@code Mono.error}, {@code onErrorMap}, returned). */
    private static final Pattern NEW_EXCEPTION = Pattern.compile("\\bnew\\s+(?:[\\w.]+\\.)?(\\w*(?:Exception|Error))\\s*\\(");

    private static final Pattern ALLOWED_REFUSAL = Pattern.compile(
        "new\\s+(?:java\\.io\\.)?UncheckedIOException\\s*\\(.*|[a-z]\\w*|[A-Za-z]\\w*\\s*\\.\\s*\\w+\\s*\\(.*", Pattern.DOTALL);

    private static boolean binding(String packagePath) {
        for (String segment : packagePath.split("[/\\\\]")) {
            if (BINDING_SEGMENTS.contains(segment)) {
                return true;
            }
        }
        return false;
    }

    private static boolean adapter(String packagePath) {
        List<String> segments = List.of(packagePath.split("[/\\\\]"));
        return segments.contains("mvc") || segments.contains("webflux");
    }

    /** Auto-configurations and properties classes: Spring wiring, not request handling. */
    private static boolean wiring(String name) {
        return name.endsWith("AutoConfiguration.java") || name.endsWith("Properties.java");
    }

    /**
     * What a store may build: a failure of its own plumbing ({@code IllegalStateException}: no generated
     * id, no SHA-256; {@code UncheckedIOException}) or an SPI's exception that carries no code or status of its own
     * ({@code DuplicatePasskeyException}, which the library maps). A library exception with a code, such as
     * {@code PasskeyException}, is the library's to build.
     */
    private static final Set<String> STORE_EXCEPTIONS = Set.of("IllegalStateException", "IllegalArgumentException", "UncheckedIOException",
        "DuplicatePasskeyException", "DatumConfigurationException");

    /**
     * The stores: a {@code Jdbc*} class in a {@code spring} package, a library SPI on
     * Spring's JDBC, and an {@code InMemory*} class there, the single-instance development default of an SPI (the
     * submission throttle, the TSA flood counter) that the framework's own rate limiting replaces. Both are wiring, not
     * adapters.
     */
    private static boolean store(String name) {
        return name.matches("(?:.*/)?spring/(?:Jdbc|InMemory)\\w+\\.java");
    }

    /**
     * What a store may not do: write a dotted or one-word wire code, pick a status, build an exception other
     * than {@link #STORE_EXCEPTIONS}, or throw a refusal of its own making. Underscored strings (table names) are its
     * business; the adapters' {@link #decisions} differ in those two allowances only.
     */
    static List<String> storeDecisions(String name, String code) {
        List<String> found = new ArrayList<>();
        Matcher literal = STRING.matcher(code);
        while (literal.find()) {
            String text = literal.group(1);
            // A property name (datum.web.throttle.limit) is a setting's, not a wire code: a configuration refusal names it.
            if ((text.matches("[a-z]+(?:\\.[a-zA-Z_]+)+") && !text.matches(".*\\.[A-Z]\\w*") && !text.startsWith("datum.")) || ONE_WORD_CODES.contains(text)) {
                found.add(name + " writes the wire code \"" + text + "\"");
            }
        }
        Matcher status = STATUS.matcher(code);
        while (status.find()) {
            found.add(name + " picks a status: " + status.group().replaceAll("\\s+", " "));
        }
        Matcher built = NEW_EXCEPTION.matcher(code);
        while (built.find()) {
            if (!STORE_EXCEPTIONS.contains(built.group(1))) {
                found.add(name + " builds the exception " + built.group(1) + " (a refusal is the library's)");
            }
        }
        Matcher refusal = REFUSAL.matcher(code);
        while (refusal.find()) {
            String carried = (refusal.group(1) != null ? refusal.group(1) : refusal.group(2)).strip();
            if (!ALLOWED_REFUSAL.matcher(carried).matches() && !NEW_EXCEPTION.matcher(carried).lookingAt()) {
                found.add(name + " makes its own refusal: " + carried.replaceAll("\\s+", " "));
            }
        }
        return found;
    }

    private static List<Path> sources() throws IOException {
        try (Stream<Path> files = Files.walk(SOURCES)) {
            return files.filter(file -> file.toString().endsWith(".java")).toList();
        }
    }

    /** The source without comments; string literals kept (a code in a string is what the rules look for). */
    static String withoutComments(String source) {
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
            } else if (c == '"' || c == '\'') {
                int from = i++;
                while (i < source.length() && source.charAt(i) != c) {
                    i += source.charAt(i) == '\\' ? 2 : 1;
                }
                i++;
                out.append(source, from, Math.min(i, source.length()));
            } else {
                out.append(c);
                i++;
            }
        }
        return out.toString();
    }

    /** What the decision rules find in one binding source (its comments already removed). */
    static List<String> decisions(String name, String code) {
        List<String> found = new ArrayList<>();
        Matcher literal = STRING.matcher(code);
        while (literal.find()) {
            String text = literal.group(1);
            if (WIRE_CODE.matcher("\"" + text + "\"").matches() && !text.matches(".*\\.[A-Z]\\w*")) {
                found.add(name + " writes the wire code \"" + text + "\"");
            } else if (ONE_WORD_CODES.contains(text)) {
                found.add(name + " writes the wire code \"" + text + "\"");
            }
        }
        if (!STATUS_WRITERS.contains(name)) {
            Matcher status = STATUS.matcher(code);
            while (status.find()) {
                found.add(name + " picks a status: " + status.group().replaceAll("\\s+", " "));
            }
        }
        Matcher built = NEW_EXCEPTION.matcher(code);
        while (built.find()) {
            if (!built.group(1).equals("UncheckedIOException")) {
                found.add(name + " builds the exception " + built.group(1) + " (a refusal is the library's)");
            }
        }
        Matcher refusal = REFUSAL.matcher(code);
        while (refusal.find()) {
            String carried = (refusal.group(1) != null ? refusal.group(1) : refusal.group(2)).strip();
            if (!ALLOWED_REFUSAL.matcher(carried).matches() && !NEW_EXCEPTION.matcher(carried).lookingAt()) {
                found.add(name + " makes its own refusal: " + carried.replaceAll("\\s+", " "));
            }
        }
        return found;
    }

    @Test
    void everyClassIsInABindingPackage() throws IOException {
        List<String> found = new ArrayList<>();
        for (Path source : sources()) {
            String name = SOURCES.relativize(source).toString().replace('\\', '/');
            if (!binding(SOURCES.relativize(source.getParent()).toString())) {
                found.add(name);
            }
        }
        assertThat(sources()).as("sources of datum-timestamp-spring").isNotEmpty();
        assertThat(found).as("library classes in the binding datum-timestamp-spring: they belong in the library module").isEmpty();
    }

    @Test
    void theModuleCarriesNoDatumResources() {
        assertThat(Path.of("src/main/resources/META-INF/datum")).as("assets, programs and migrations are the library's").doesNotExist();
    }

    @Test
    void theAdaptersShapeNoJson() throws IOException {
        List<String> found = new ArrayList<>();
        for (Path source : sources()) {
            String name = SOURCES.relativize(source).toString().replace('\\', '/');
            if (adapter(SOURCES.relativize(source.getParent()).toString()) && !BODY_READERS.contains(name)
                && withoutComments(Files.readString(source)).contains("tools.jackson")) {
                found.add(name + " shapes JSON (tools.jackson)");
            }
        }
        assertThat(found).as("JSON shaped in the adapters of datum-timestamp-spring").isEmpty();
    }

    @Test
    void noBindingClassDecidesAnAnswer() throws IOException {
        List<String> found = new ArrayList<>();
        for (Path source : sources()) {
            String name = SOURCES.relativize(source).toString().replace('\\', '/');
            if (store(name)) {
                found.addAll(storeDecisions(name, withoutComments(Files.readString(source))));
            } else if (!wiring(name)) {
                found.addAll(decisions(name, withoutComments(Files.readString(source))));
            }
        }
        assertThat(found).as("facade logic in the binding classes of datum-timestamp-spring").isEmpty();
    }

    @Test
    void theRulesSeeWhatTheyLookFor() {
        assertThat(binding("com/argusvane/datum/forms/web/mvc")).isTrue();
        assertThat(binding("com/argusvane/datum/forms/web")).isFalse();
        assertThat(adapter("com/argusvane/datum/forms/web/webflux")).isTrue();
        assertThat(adapter("com/argusvane/datum/forms/spring")).isFalse();
        assertThat(wiring("x/DatumFormsAutoConfiguration.java")).isTrue();
        assertThat(wiring("x/PdfWebConfiguration.java")).isFalse();
        // The stores' narrower rule: table names and the SPI's exceptions pass, a wire code or a status does not.
        assertThat(store("com/argusvane/datum/webauthn/spring/JdbcPasskeyRepository.java")).isTrue();
        assertThat(store("com/argusvane/datum/webauthn/web/mvc/JdbcPasskeys.java")).isFalse();
        assertThat(store("com/argusvane/datum/submissions/spring/InMemorySubmissionThrottle.java")).isTrue();
        assertThat(store("com/argusvane/datum/submissions/web/mvc/InMemoryThing.java")).isFalse();
        assertThat(store("com/argusvane/datum/forms/spring/DatumFormsAutoConfiguration.java")).isFalse();
        assertThat(storeDecisions("S", "TABLE = \"datum_passkey_use\"; throw new DuplicatePasskeyException(\"x\", e);"
            + " throw new IllegalStateException(\"no id\"); throw PasskeyRepository.unstorable();")).isEmpty();
        assertThat(storeDecisions("S", "x = \"passkey.invalid\"; y = \"flood\"; return ResponseEntity.status(422).build();")).hasSize(3);
        // A refusal built from a code constant and a bare status, or by a helper of the store's own.
        assertThat(storeDecisions("S", "throw new PasskeyException(PasskeyCodes.INVALID, 422, \"The passkey could not be stored.\", null);"))
            .hasSize(1);
        assertThat(storeDecisions("S", "return Mono.error(new BadRequestException(\"x\"));")).hasSize(1);
        assertThat(storeDecisions("S", "throw refuse(e);")).hasSize(1);
        // Wire codes in every spelling; class names, media types, header and parameter names are not codes.
        assertThat(decisions("A", "x = \"form.notFound\"; y = \"bad_document\"; z = \"required\"; w = \"flood\";")).hasSize(4);
        assertThat(decisions("A", "a = \"application/json\"; b = \"X-Page-Count\"; c = \"datum\"; d = \"key\";"
            + " e = \"org.springframework.web.servlet.DispatcherServlet\";")).isEmpty();
        // A status the binding picks, in any form; a status the library's reply carries is not one.
        assertThat(decisions("A", "return ResponseEntity.status(422).body(x);")).hasSize(1);
        assertThat(decisions("A", "return ResponseEntity.status(ok ? 200 : 404).build();")).hasSize(1);
        assertThat(decisions("A", "return ServerResponse.status(405).header(\"Allow\", allow).build();")).hasSize(1);
        assertThat(decisions("A", "return ServerResponse.status(HttpStatus.NOT_FOUND).build();")).hasSize(1);
        assertThat(decisions("A", "return ResponseEntity.notFound().build();")).hasSize(1);
        assertThat(decisions("A", "response.setStatusCode(HttpStatusCode.valueOf(405));")).hasSize(1);
        assertThat(decisions("A", "return ResponseEntity.status(reply.status()).body(reply.body()); return ServerResponse.ok().build();"
            + " x.setStatusCode(HttpStatusCode.valueOf(answer.status())); HttpStatus.OK;")).isEmpty();
        assertThat(decisions(STATUS_WRITERS.iterator().next(), "response.setStatusCode(HttpStatusCode.valueOf(405));")).isEmpty();
        // Refusals: only an I/O failure, a caught exception passed on, or one a library class made.
        assertThat(decisions("A", "throw new BadRequestException(\"x\");")).hasSize(1);
        assertThat(decisions("A", "throw refuse();")).hasSize(1);
        assertThat(decisions("A", "return Mono.error(new IllegalArgumentException(\"x\"));")).hasSize(1);
        assertThat(decisions("A", "return body.onErrorMap(Overflow.class, e -> new RequestTooLargeException(1, \"x\"));")).hasSize(1);
        assertThat(decisions("A", "throw new UncheckedIOException(\"x\", e); throw new java.io.UncheckedIOException(e); throw e;"
            + " throw api.fileTooLarge(); return Mono.error(refusal); return Mono.error(JsonBodies.tooLarge(cap));")).isEmpty();
        assertThat(withoutComments("a // \"bad_document\"\n/* throw new X(); */ b = \"x//y\";")).doesNotContain("bad_document")
            .doesNotContain("throw").contains("\"x//y\"");
    }
}
