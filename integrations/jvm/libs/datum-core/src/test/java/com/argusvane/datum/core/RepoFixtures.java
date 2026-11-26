package com.argusvane.datum.core;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * The monorepo's own fixture files from wherever Maven runs the tests, and the generated copies on the test class path
 * ({@code datum-fixtures/}, written by the asset build from the suite's goldens, the engine and integrations/shared).
 */
public final class RepoFixtures {

    public static final JsonMapper MAPPER = com.argusvane.datum.core.contracts.DatumJson.mapper();

    private RepoFixtures() {
    }

    /** The monorepo root: the nearest parent holding both {@code engine} and {@code integrations/shared}. */
    public static Path root() {
        Path dir = Path.of("").toAbsolutePath();
        while (dir != null) {
            if (Files.isDirectory(dir.resolve("engine")) && Files.isDirectory(dir.resolve("integrations/shared"))) {
                return dir;
            }
            dir = dir.getParent();
        }
        throw new IllegalStateException("The Datum monorepo root was not found above " + Path.of("").toAbsolutePath());
    }

    public static String text(String relative) {
        try {
            return Files.readString(root().resolve(relative), StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new IllegalStateException("Fixture " + relative + " is missing", e);
        }
    }

    public static JsonNode json(String relative) {
        return MAPPER.readTree(text(relative));
    }

    /** A generated fixture copy on the test class path ({@code datum-fixtures/<name>}). */
    public static JsonNode fixture(String name) {
        try (java.io.InputStream in = RepoFixtures.class.getResourceAsStream("/datum-fixtures/" + name)) {
            if (in == null) {
                throw new IllegalStateException("datum-fixtures/" + name + " is missing: run ./mvnw -N generate-resources in integrations/jvm.");
            }
            return MAPPER.readTree(new String(in.readAllBytes(), StandardCharsets.UTF_8));
        } catch (IOException e) {
            throw new IllegalStateException("Fixture datum-fixtures/" + name + " cannot be read", e);
        }
    }
}
