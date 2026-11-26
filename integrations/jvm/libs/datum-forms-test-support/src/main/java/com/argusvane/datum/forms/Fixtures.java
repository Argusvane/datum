package com.argusvane.datum.forms;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

/** Test files from the monorepo, found by walking up from where Maven runs the tests. */
public final class Fixtures {

    static final JsonMapper MAPPER = com.argusvane.datum.core.contracts.DatumJson.mapper();

    private Fixtures() {
    }

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

    /** The security suite's endpoint fixture: a form with text, container, select, checkboxes, a repeating group and a server-secret rule. */
    public static ObjectNode endpointFixture() {
        return json("packages/conformance-suite/fixtures/endpoint-fixture.definition.json");
    }

    public static ObjectNode json(String relative) {
        try {
            return (ObjectNode) MAPPER.readTree(Files.readString(root().resolve(relative), StandardCharsets.UTF_8));
        } catch (IOException e) {
            throw new IllegalStateException("Fixture " + relative + " is missing", e);
        }
    }

    public static ObjectNode parse(String text) {
        return (ObjectNode) MAPPER.readTree(text);
    }

    public static JsonNode node(String text) {
        return MAPPER.readTree(text);
    }
}
