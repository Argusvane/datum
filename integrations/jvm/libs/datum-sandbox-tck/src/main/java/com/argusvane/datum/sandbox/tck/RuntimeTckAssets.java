package com.argusvane.datum.sandbox.tck;

import com.argusvane.datum.sandbox.protocol.Program;
import com.argusvane.datum.sandbox.protocol.RunScript;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Map;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * The real programs and the pinned fixtures, as the contracts read them.
 *
 * <p>Programs, fonts and the freeze snippet come from datum-programs on the class path ({@code META-INF/datum/programs/}).
 * The fixtures travel in this kit's jar ({@code META-INF/datum-sandbox-tck/}, written by the asset generation from the
 * conformance suite's golden file and fixture form and the PDF kernel's parity documents), so an engine outside this
 * repository is judged by the very bytes the TypeScript side checks. Inside the repository an IDE run without processed
 * resources falls back to those source files.
 */
public final class RuntimeTckAssets {

    /** The JSON mapper the contracts read and write with. */
    public static final JsonMapper JSON = JsonMapper.builder().build();

    /** Where the kit's fixtures are on the class path. */
    public static final String FIXTURES = "META-INF/datum-sandbox-tck/";

    private static final String PROGRAMS = "META-INF/datum/programs/";

    /** Where each fixture is in the repository, for the fallback. */
    private static final Map<String, String> REPO_FIXTURES = Map.of(
        "golden.json", "packages/conformance-suite/golden/abi-1.0.json",
        "fixture-form.json", "packages/conformance-suite/fixtures/endpoint-fixture.definition.json");

    private RuntimeTckAssets() {
    }

    /** The real sandbox program. */
    public static Program sandboxProgram() {
        return Program.of(Program.Kind.SANDBOX, programFile("datum-sandbox-program.js"));
    }

    /** The real PDF program. */
    public static Program pdfProgram() {
        return Program.of(Program.Kind.PDF, programFile("datum-pdf-program.js"));
    }

    /** A program file: datum-programs' copy, else the web components build's. */
    public static byte[] programFile(String name) {
        byte[] bytes = resource(PROGRAMS + name);
        if (bytes != null) {
            return bytes;
        }
        Path dist = repo().resolve("packages/datum/dist").resolve(name);
        try {
            return Files.readAllBytes(dist);
        } catch (IOException e) {
            throw new UncheckedIOException("Neither datum-programs nor " + dist + " has " + name + ": put datum-programs on the test class path.", e);
        }
    }

    /** One of the PDF fonts datum-programs carries. */
    public static byte[] font(String file) {
        byte[] bytes = resource(PROGRAMS + "fonts/" + file);
        if (bytes == null) {
            throw new IllegalStateException("datum-programs has no font " + file + ": put datum-programs on the test class path.");
        }
        return bytes;
    }

    /** The run.js generator with the packaged freeze snippet. */
    public static RunScript scripts() {
        return RunScript.fromClasspath(RuntimeTckAssets.class.getClassLoader());
    }

    /** A fixture's bytes: {@code golden.json}, {@code fixture-form.json} or {@code documents/<name>.json}. */
    public static byte[] fixtureBytes(String name) {
        byte[] bytes = resource(FIXTURES + name);
        if (bytes != null) {
            return bytes;
        }
        String relative = REPO_FIXTURES.getOrDefault(name,
            name.startsWith("documents/") ? "packages/pdf-kernel/tests/fixtures/" + name : null);
        if (relative == null) {
            throw new IllegalStateException("The engine kit has no fixture " + name);
        }
        try {
            return Files.readAllBytes(repo().resolve(relative));
        } catch (IOException | IllegalStateException e) {
            throw new IllegalStateException("The engine kit's fixture " + name + " is neither in its jar (" + FIXTURES + name + ") nor at "
                + relative, e);
        }
    }

    /** A fixture as JSON. */
    public static JsonNode fixture(String name) {
        return JSON.readTree(fixtureBytes(name));
    }

    /** A lower-case hex sha256. */
    public static String sha256(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /** UTF-8 text. */
    public static String text(byte[] bytes) {
        return new String(bytes, StandardCharsets.UTF_8);
    }

    /** The monorepo root: the first directory up from the working directory that holds packages/conformance-suite. */
    static Path repo() {
        Path at = Path.of(System.getProperty("user.dir")).toAbsolutePath();
        for (Path dir = at; dir != null; dir = dir.getParent()) {
            if (Files.isDirectory(dir.resolve("packages/conformance-suite"))) {
                return dir;
            }
        }
        throw new IllegalStateException("Not inside the datum monorepo: " + at);
    }

    private static byte[] resource(String name) {
        try (InputStream in = RuntimeTckAssets.class.getClassLoader().getResourceAsStream(name)) {
            return in == null ? null : in.readAllBytes();
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }
}
