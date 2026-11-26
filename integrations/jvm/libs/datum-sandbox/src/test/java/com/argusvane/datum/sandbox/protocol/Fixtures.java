package com.argusvane.datum.sandbox.protocol;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import tools.jackson.databind.JsonNode;

/** Test resources of this package, and the monorepo files the parity tests read. */
final class Fixtures {

    static final String NONCE = "0123456789abcdef0123456789abcdef";

    private Fixtures() {
    }

    static JsonNode json(String resource) {
        try (InputStream in = Fixtures.class.getClassLoader().getResourceAsStream("sandbox/" + resource)) {
            if (in == null) {
                throw new IllegalStateException("Missing test resource sandbox/" + resource);
            }
            return StrictJson.mapper().readTree(new String(in.readAllBytes(), StandardCharsets.UTF_8));
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    /** A file of the monorepo, or null when the module is built outside it. */
    static String repoText(String relative) {
        Path dir = Path.of("").toAbsolutePath();
        while (dir != null) {
            Path candidate = dir.resolve(relative);
            if (Files.isDirectory(dir.resolve("integrations/shared")) && Files.isRegularFile(candidate)) {
                try {
                    return Files.readString(candidate, StandardCharsets.UTF_8);
                } catch (IOException e) {
                    throw new UncheckedIOException(e);
                }
            }
            dir = dir.getParent();
        }
        return null;
    }

    static byte[] utf8(String text) {
        return text.getBytes(StandardCharsets.UTF_8);
    }

    static String started() {
        return Frame.marker(NONCE, "started");
    }

    static String begin() {
        return Frame.marker(NONCE, "begin");
    }

    static String end() {
        return Frame.marker(NONCE, "end");
    }

    /** The stdout of a run that answered {@code answer}, framed as run.js frames it. */
    static String frame(String nonce, String answer) {
        return Frame.marker(nonce, "started") + "\n" + Frame.marker(nonce, "begin") + "\n" + answer + "\n" + Frame.marker(nonce, "end") + "\n";
    }
}
