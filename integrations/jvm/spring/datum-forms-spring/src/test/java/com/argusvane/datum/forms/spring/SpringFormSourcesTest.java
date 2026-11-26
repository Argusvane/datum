package com.argusvane.datum.forms.spring;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assumptions.assumeFalse;

import com.argusvane.datum.forms.FormSources;
import com.argusvane.datum.forms.ResourceFormDefinitionRepository;
import java.io.IOException;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.core.io.support.PathMatchingResourcePatternResolver;

/**
 * The Spring half of the locations: class path and {@code file:} patterns, both through Spring's resolver (the {@code file:}
 * glob walk is Spring's).
 */
class SpringFormSourcesTest {

    @TempDir
    Path dir;

    @Test
    void classpathAndFilePatternsAreSpringsAlike() throws IOException {
        Path classes = Files.createDirectories(dir.resolve("classes/datum/forms"));
        Files.writeString(classes.resolve("intake.json"), "{\"id\":\"intake\",\"root\":{\"configuration\":{\"label\":\"Intake\"}}}");
        Path files = Files.createDirectories(dir.resolve("files"));
        Files.writeString(files.resolve("survey.json"), "{\"id\":\"survey\",\"root\":{}}");
        try (URLClassLoader loader = new URLClassLoader(new URL[] {dir.resolve("classes").toUri().toURL()}, null)) {
            ResourceFormDefinitionRepository repository = new ResourceFormDefinitionRepository(
                SpringFormSources.resolver(new PathMatchingResourcePatternResolver(loader)),
                List.of("classpath:/datum/forms/*.json", "file:" + files + "/*.json"));
            assertThat(repository.size()).isEqualTo(2);
            assertThat(repository.find("intake")).isPresent();
            assertThat(repository.find("survey")).isPresent();
        }
    }

    @Test
    void twoFilesWithOneKeyStopTheStartNamingBoth() throws IOException {
        Path classes = Files.createDirectories(dir.resolve("classes/datum/forms"));
        Files.writeString(classes.resolve("a.json"), "{\"id\":\"same\",\"root\":{}}");
        Path files = Files.createDirectories(dir.resolve("files"));
        Files.writeString(files.resolve("b.json"), "{\"id\":\"same\",\"root\":{}}");
        try (URLClassLoader loader = new URLClassLoader(new URL[] {dir.resolve("classes").toUri().toURL()}, null)) {
            assertThatThrownBy(() -> new ResourceFormDefinitionRepository(SpringFormSources.resolver(new PathMatchingResourcePatternResolver(loader)),
                List.of("classpath:/datum/forms/*.json", "file:" + files + "/*.json")))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("Two form definitions have the key \"same\"")
                .hasMessageContaining("a.json").hasMessageContaining("b.json");
        }
    }

    private void write(String path, String json) throws IOException {
        Path file = dir.resolve(path);
        Files.createDirectories(file.getParent());
        Files.writeString(file, json);
    }

    private List<String> names(String location) throws IOException {
        return SpringFormSources.resolver(new PathMatchingResourcePatternResolver()).resolve(location).stream()
            .map(FormSources.Source::fileName).toList();
    }

    @Test
    void fileLocationsAreSpringsAntPatterns() throws IOException {
        write("a.json", "{}");
        write("b.json", "{}");
        write("notes.txt", "x");
        write("nested/c.json", "{}");
        write("nested/deeper/d.json", "{}");

        assertThat(names("file:" + dir + "/*.json")).containsExactly("a.json", "b.json");
        assertThat(names("file:" + dir + "/**/*.json")).containsExactly("a.json", "b.json", "c.json", "d.json");
        assertThat(names("file:" + dir + "/nested/**/*.json")).containsExactly("c.json", "d.json");
        assertThat(names("file:" + dir + "/?.json")).containsExactly("a.json", "b.json");
        assertThat(names("file:" + dir + "/a.json")).containsExactly("a.json");
        assertThat(names("file:" + dir + "/missing.json")).isEmpty();
        assertThat(names("file:" + dir + "/missing/*.json")).as("a base directory that does not exist finds nothing").isEmpty();
        assertThat(names("file:" + dir + "/nested")).as("a directory is not a definition").isEmpty();

        FormSources.Source a = SpringFormSources.resolver(new PathMatchingResourcePatternResolver()).resolve("file:" + dir + "/a.json").get(0);
        assertThat(a.where()).startsWith("file:").endsWith("/a.json");
        assertThat(new String(a.bytes().read(), StandardCharsets.UTF_8)).isEqualTo("{}");
    }

    /**
     * An unreadable directory below the base (a lost+found, a root-only folder under /etc/datum/forms): Spring's resolver
     * logs "Failed to search in directory" and finds nothing below that base, whatever the pattern (it walks the whole tree;
     * the library's own walk used to stop at the depth a pattern can reach, which Spring does not), and the repository
     * says so in a WARN: the start goes on with no forms from that base rather than failing.
     */
    @Test
    void anUnreadableSubdirectoryDoesNotStopTheStart() throws IOException {
        write("a.json", "{\"id\":\"a\",\"root\":{}}");
        write("nested/c.json", "{\"id\":\"c\",\"root\":{}}");
        Path locked = Files.createDirectory(dir.resolve("locked"));
        Files.writeString(locked.resolve("hidden.json"), "{}");
        Files.setPosixFilePermissions(locked, PosixFilePermissions.fromString("---------"));
        try {
            assumeFalse(Files.isReadable(locked), "the test user reads every directory (root)");
            ResourceFormDefinitionRepository repository = new ResourceFormDefinitionRepository(
                SpringFormSources.resolver(new PathMatchingResourcePatternResolver()),
                List.of("file:" + dir + "/**/*.json", "file:" + dir + "/*.json"));
            assertThat(repository.size()).as("nothing is read below a base Spring could not search").isZero();
        } finally {
            Files.setPosixFilePermissions(locked, PosixFilePermissions.fromString("rwx------"));
        }
    }
}
