package com.argusvane.datum.ui.builder;

import com.argusvane.datum.core.contracts.DatumJson;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Optional;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * The definitions the builder tests save: the security suite's endpoint fixture, the suite's edits of it (DEF-12
 * risky pattern, DEF-03 duplicate ids) and the real kernel's answers to those, captured in
 * {@code kernel-check-answers.json}.
 *
 * <p>The fixture is a copy beside this class ({@code endpoint-fixture.definition.json}, byte-equal to
 * {@code packages/conformance-suite/fixtures/endpoint-fixture.definition.json} at commit 4865502, sha256 b90b4bb3...),
 * so the module's tests run outside this checkout too (a copy of {@code integrations/jvm} or a
 * source release failed 26 tests before testing anything). The copy and the captured answers belong together:
 * {@code BuilderFixturesTest} fails when the suite's fixture moves on, and both are then copied and captured again.
 */
public final class BuilderFixtures {

    /** The suite fixture's id, and so the key these tests store it under. */
    public static final String KEY = "datum-security-suite";

    /** Where the suite keeps the fixture this class carries a copy of. */
    static final String SUITE_FIXTURE = "packages/conformance-suite/fixtures/endpoint-fixture.definition.json";

    /** The copy, a class-path resource beside this class. */
    static final String COPY = "endpoint-fixture.definition.json";

    private BuilderFixtures() {
    }

    /** A fresh copy of the suite fixture. */
    public static ObjectNode base() {
        return (ObjectNode) DatumJson.mapper().readTree(resource(COPY));
    }

    /** DEF-12 risky-pattern: the fixture plus {@code fx} whose visibleWhen is {@code matches(name, "(a|a?)+")}. */
    public static ObjectNode riskyPattern() {
        ObjectNode definition = base();
        ObjectNode fx = content(definition).addObject();
        fx.put("id", "fx");
        fx.put("type", "text");
        fx.putObject("configuration");
        ObjectNode rule = fx.putObject("rules").putObject("visibleWhen");
        rule.put("run", "both");
        rule.put("formula", "matches(name, \"(a|a?)+\")");
        return definition;
    }

    /** DEF-12 browser-function-under-warn: the fixture plus {@code fx} whose visibleWhen calls an unknown browser function. */
    public static ObjectNode unknownBrowserFunction() {
        ObjectNode definition = base();
        ObjectNode fx = content(definition).addObject();
        fx.put("id", "fx");
        fx.put("type", "text");
        fx.putObject("configuration");
        ObjectNode rule = fx.putObject("rules").putObject("visibleWhen");
        rule.put("run", "browser");
        rule.put("formula", "nosuchfn(name) = 1");
        return definition;
    }

    /** DEF-03: the fixture plus two text components with the id {@code dup}. */
    public static ObjectNode duplicateIds() {
        ObjectNode definition = base();
        for (int i = 0; i < 2; i++) {
            ObjectNode dup = content(definition).addObject();
            dup.put("id", "dup");
            dup.put("type", "text");
            dup.putObject("configuration");
        }
        return definition;
    }

    /** The real kernel's answer captured for a case ({@code riskyPattern}, {@code duplicateIds}), as JSON text. */
    public static String capturedAnswer(String name) {
        JsonNode all = DatumJson.mapper().readTree(resource("kernel-check-answers.json"));
        return DatumJson.mapper().writeValueAsString(all.get(name));
    }

    /** A resource beside this class, as bytes. */
    static byte[] resource(String name) {
        try (InputStream in = BuilderFixtures.class.getResourceAsStream(name)) {
            if (in == null) {
                throw new IllegalStateException("The test resource " + name + " is missing beside " + BuilderFixtures.class.getName());
            }
            return in.readAllBytes();
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    /** The form's content list. */
    public static ArrayNode content(ObjectNode definition) {
        return (ArrayNode) definition.get("root").get("children").get("content");
    }

    /** A file of the repository, found from the module's directory upwards; empty outside the checkout. */
    static Optional<Path> repositoryFile(String relative) {
        Path dir = Path.of("").toAbsolutePath();
        while (dir != null) {
            Path candidate = dir.resolve(relative);
            if (Files.isRegularFile(candidate)) {
                return Optional.of(candidate);
            }
            dir = dir.getParent();
        }
        return Optional.empty();
    }
}
