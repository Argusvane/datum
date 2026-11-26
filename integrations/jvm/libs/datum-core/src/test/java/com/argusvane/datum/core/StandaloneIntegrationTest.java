package com.argusvane.datum.core;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;

/**
 * The JVM integration is standalone: no file of {@code integrations/jvm} names another integration.
 * A rule, a limit or a byte shape names its real source instead: the endpoint catalog, a
 * conformance-suite vector, the kernel ABI or an RFC.
 *
 * <p>Every text file under {@code integrations/jvm} is read, except build output: any
 * {@code target/} and {@code node_modules/} directory, the root's release output {@code dist/},
 * and the flatten plugin's {@code .flattened-pom.xml} (generated, gitignored). A directory named {@code assets} or
 * {@code dist} anywhere else is source (the Java packages {@code ...core.assets} and {@code ...web.assets}, the test
 * resources under {@code META-INF/datum/assets}) and is read: the generated assets are written under {@code target/}. The words are {@code drupal},
 * {@code wordpress} and {@code php}, in any case, as whole words and as the parts of an identifier
 * ({@code ensureDrupalShape}, {@code isPhpTrimmed}, {@code PHP_INT_MAX}, {@code WordPress}); {@code phpunit} or
 * {@code graphpaper} are other words. The conformance suite ({@code packages/conformance-suite}, which is host-neutral
 * and has a profile per host) and {@code docs/adr} are outside this tree. This file is
 * the one exception inside it: it names the words to find them.
 */
class StandaloneIntegrationTest {

    private static final Set<String> WORDS = Set.of("drupal", "wordpress", "php");
    /** Skipped at any depth: build output. */
    private static final Set<String> SKIPPED_DIRECTORIES = Set.of("target", "node_modules");
    /** Skipped only directly under integrations/jvm: the release output. */
    private static final Set<String> SKIPPED_ROOT_DIRECTORIES = Set.of("dist");
    private static final Set<String> SKIPPED_FILES = Set.of(".flattened-pom.xml", ".DS_Store");
    /** This test's own source, which names the words it looks for. */
    private static final Path SELF = Path.of("libs", "datum-core", "src", "test", "java", "com", "argusvane", "datum", "core",
        "StandaloneIntegrationTest.java");
    private static final Pattern RUN = Pattern.compile("[A-Za-z0-9]+");
    /** Where an identifier splits: lower to upper, an acronym's end (PHPTrim), letters to digits and back. */
    private static final Pattern PARTS = Pattern.compile("(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|(?<=[A-Za-z])(?=[0-9])|(?<=[0-9])(?=[A-Za-z])");

    /** The integrations/jvm directory: the nearest parent of the working directory holding this module. */
    static Path jvmRoot() {
        Path dir = Path.of("").toAbsolutePath();
        while (dir != null) {
            if (Files.isRegularFile(dir.resolve("pom.xml")) && Files.isDirectory(dir.resolve("libs/datum-core"))) {
                return dir;
            }
            dir = dir.getParent();
        }
        throw new IllegalStateException("integrations/jvm was not found above " + Path.of("").toAbsolutePath());
    }

    /** Whether a line names one of the words, as a word or as a part of an identifier. */
    static boolean names(String line) {
        Matcher run = RUN.matcher(line);
        while (run.find()) {
            String[] parts = PARTS.split(run.group());
            for (int i = 0; i < parts.length; i++) {
                String part = parts[i].toLowerCase(Locale.ROOT);
                if (WORDS.contains(part) || i + 1 < parts.length && WORDS.contains(part + parts[i + 1].toLowerCase(Locale.ROOT))) {
                    return true;
                }
            }
        }
        return false;
    }

    /** The file's text, or null when it is not UTF-8 text (a jar, a key store, a PDF, an image). */
    private static String text(Path file) {
        try {
            byte[] bytes = Files.readAllBytes(file);
            for (int i = 0; i < Math.min(bytes.length, 8192); i++) {
                if (bytes[i] == 0) {
                    return null;
                }
            }
            return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
        } catch (CharacterCodingException e) {
            return null;
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    /** Whether a file, given relative to integrations/jvm, is scanned. */
    static boolean scanned(Path relative) {
        if (relative.getNameCount() > 1 && SKIPPED_ROOT_DIRECTORIES.contains(relative.getName(0).toString())) {
            return false;
        }
        for (int i = 0; i < relative.getNameCount() - 1; i++) {
            if (SKIPPED_DIRECTORIES.contains(relative.getName(i).toString())) {
                return false;
            }
        }
        return !SKIPPED_FILES.contains(relative.getFileName().toString()) && !relative.equals(SELF);
    }

    private static boolean scanned(Path root, Path file) {
        return scanned(root.relativize(file));
    }

    @Test
    void noFileOfTheJvmIntegrationNamesAnotherIntegration() throws IOException {
        Path root = jvmRoot();
        List<String> found = new ArrayList<>();
        int files = 0;
        try (Stream<Path> walk = Files.walk(root)) {
            for (Path file : (Iterable<Path>) walk.filter(Files::isRegularFile).filter(file -> scanned(root, file))::iterator) {
                String text = text(file);
                if (text == null) {
                    continue;
                }
                files++;
                String[] lines = text.split("\r\n|\r|\n", -1);
                for (int i = 0; i < lines.length; i++) {
                    if (names(lines[i])) {
                        found.add(root.relativize(file) + ":" + (i + 1) + ": " + lines[i].strip());
                    }
                }
            }
        }
        assertThat(files).as("the scan read the tree").isGreaterThan(500);
        assertThat(found).as("lines of integrations/jvm that name another integration (name the contract instead)").isEmpty();
    }

    /** Only build output is skipped: an assets or dist directory below the root is source and is read. */
    @Test
    void onlyBuildOutputIsSkipped() {
        for (String path : List.of("libs/x/src/main/java/a/assets/B.java", "libs/datum-core/src/main/java/com/argusvane/datum/core/assets/AssetManifest.java",
            "libs/datum-web-core/src/test/resources/META-INF/datum/assets/x.js", "libs/x/dist/y.md", "examples/ui/assets/z.txt",
            "pom.xml", "README.md")) {
            assertThat(scanned(Path.of(path))).as(path).isTrue();
        }
        for (String path : List.of("target/x.txt", "libs/x/target/classes/y.properties", "dist/datum-1.0.0/README.md",
            "libs/x/node_modules/y/index.js", "libs/x/.flattened-pom.xml", SELF.toString())) {
            assertThat(scanned(Path.of(path))).as(path).isFalse();
        }
    }

    @Test
    void theWordsAreFoundAsWordsAndAsIdentifierParts() {
        for (String line : List.of("as Drupal does", "drupal:assets", "integrations/drupal/datum", "PHP's trim()", "ensureDrupalShape",
            "isPhpTrimmed", "phpDepth", "PHP_INT_MAX", "WordPress", "wordpress.org", "a PHPTrim helper", "Drupal8")) {
            assertThat(names(line)).as(line).isTrue();
        }
        for (String line : List.of("phpunit", "graphpaper", "drupalish", "Datum's own rule")) {
            assertThat(names(line)).as(line).isFalse();
        }
    }
}
