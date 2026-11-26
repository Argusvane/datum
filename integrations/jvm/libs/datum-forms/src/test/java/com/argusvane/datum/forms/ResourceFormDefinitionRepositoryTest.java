package com.argusvane.datum.forms;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.core.canonical.CanonicalJson;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.node.ObjectNode;

/**
 * The read-only repository over resources: keys, duplicates, copies. It is given a {@link FormSources.Resolver}
 * (here one over a temporary directory); resolving {@code classpath:} and {@code file:} globs is the Spring
 * binding's, tested by {@code SpringFormSourcesTest}.
 */
class ResourceFormDefinitionRepositoryTest {

    @TempDir
    Path dir;

    private String pattern;

    @BeforeEach
    void pattern() {
        pattern = "file:" + dir.toAbsolutePath() + "/*.json";
    }

    private ResourceFormDefinitionRepository repository() {
        return new ResourceFormDefinitionRepository(resolver(dir), List.of(pattern));
    }

    /** A resolver over one directory: any location under it finds the {@code .json} files directly in it. */
    static FormSources.Resolver resolver(Path dir) {
        return location -> {
            if (!location.contains("/missing/")) {
                try (java.util.stream.Stream<Path> files = Files.list(dir)) {
                    return files.filter(file -> file.getFileName().toString().endsWith(".json")).sorted()
                        .map(file -> new FormSources.Source(file.getFileName().toString(), "file:" + file.toAbsolutePath(),
                            () -> Files.readAllBytes(file)))
                        .toList();
                }
            }
            return List.of();
        };
    }

    private void write(String file, String json) throws IOException {
        Files.writeString(dir.resolve(file), json);
    }

    @Test
    void theFileNameIsTheKeyUnlessTheIdDiffers() throws IOException {
        // The security suite's fixture has id "datum-security-suite": the id wins over the file name.
        write("contact.json", Fixtures.endpointFixture().toString());
        write("survey.json", "{\"id\":\"survey\",\"root\":{\"id\":\"form\",\"type\":\"form\",\"configuration\":{\"label\":\"Customer survey\"}}}");
        write("no-id.json", "{\"root\":{\"id\":\"form\",\"type\":\"form\",\"configuration\":{}}}");

        ResourceFormDefinitionRepository repository = repository();

        assertThat(repository.find("datum-security-suite")).isPresent();
        assertThat(repository.find("contact")).isEmpty();
        assertThat(repository.find("survey")).isPresent();
        assertThat(repository.find("no-id")).isPresent();
        assertThat(repository.size()).isEqualTo(3);
    }

    @Test
    void currentCarriesTheCanonicalHashAndReturnsACopy() throws IOException {
        ObjectNode fixture = Fixtures.endpointFixture();
        write("endpoint.json", fixture.toString());
        ResourceFormDefinitionRepository repository = repository();

        CurrentDefinition current = repository.current("datum-security-suite");

        assertThat(current.sha256()).isEqualTo(CanonicalJson.digest(fixture)).hasSize(64);
        current.definition().put("version", "tampered");
        assertThat(repository.current("datum-security-suite").definition().path("version").asString()).isEqualTo("1");
        assertThat(repository.find("datum-security-suite").orElseThrow().path("version").asString()).isEqualTo("1");
    }

    @Test
    void anUnknownKeyIsNotFound() {
        assertThatThrownBy(() -> repository().current("nope")).isInstanceOf(FormNotFoundException.class)
            .satisfies(e -> assertThat(((FormNotFoundException) e).httpStatus()).isEqualTo(404));
    }

    @Test
    void twoFilesWithOneKeyRefuseToStart() throws IOException {
        write("a.json", "{\"id\":\"same\",\"root\":{}}");
        write("b.json", "{\"id\":\"same\",\"root\":{}}");

        assertThatThrownBy(this::repository).isInstanceOf(IllegalStateException.class).hasMessageContaining("\"same\"");
    }

    @Test
    void aFileThatIsNotAnObjectOrNotJsonFailsTheStart() throws IOException {
        write("list.json", "[1,2]");
        assertThatThrownBy(this::repository).isInstanceOf(IllegalStateException.class).hasMessageContaining("list.json");
    }

    @Test
    void savingAnswers501() throws IOException {
        write("a.json", "{\"id\":\"a\",\"root\":{}}");
        assertThatThrownBy(() -> repository().save(Fixtures.parse("{\"id\":\"a\"}")))
            .isInstanceOfSatisfying(FormStoreReadOnlyException.class, e -> {
                assertThat(e.httpStatus()).isEqualTo(501);
                assertThat(e.code()).isEqualTo("forms.readOnly");
            });
        assertThatThrownBy(() -> repository().save(Fixtures.parse("{\"id\":\"a\"}"), null)).isInstanceOf(FormStoreReadOnlyException.class);
    }

    @Test
    void aLocationThatMatchesNothingFindsNothing() {
        ResourceFormDefinitionRepository repository = new ResourceFormDefinitionRepository(resolver(dir),
            List.of("file:" + dir.toAbsolutePath() + "/missing/*.json"));
        assertThat(repository.size()).isZero();
    }

    @Test
    void aKeyThatIsNotAURLSegmentOrIsTooLongFailsTheStartNamingTheFile() throws IOException {
        write("bad.json", "{\"id\":\"a/b\",\"root\":{}}");
        assertThatThrownBy(this::repository).isInstanceOf(IllegalStateException.class).hasMessageContaining("a/b").hasMessageContaining("bad.json");
        Files.delete(dir.resolve("bad.json"));
        write("long.json", "{\"id\":\"" + "k".repeat(129) + "\",\"root\":{}}");
        assertThatThrownBy(this::repository).isInstanceOf(IllegalStateException.class).hasMessageContaining("128");
    }
}
