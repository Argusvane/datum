package com.argusvane.datum.pdf;

import com.argusvane.datum.sandbox.protocol.Program;
import com.argusvane.datum.timestamp.TsaKey;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.List;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * The fixtures the tests read: the PDF kernel's signing fixtures and parity documents
 * ({@code packages/pdf-kernel/tests/fixtures/}, read from the repository: datum-pdf has no generated
 * {@code datum-fixtures/} rows), and the PDF program and fonts from
 * datum-programs on the class path.
 */
public final class TestAssets {

    public static final JsonMapper JSON = JsonMapper.builder().build();

    private TestAssets() {
    }

    /** The monorepo root: {@code -Ddatum.repo}, else the first directory up from the working directory that holds packages/pdf-kernel. */
    public static Path repo() {
        String given = System.getProperty("datum.repo");
        if (given != null && !given.isBlank()) {
            return Path.of(given);
        }
        Path at = Path.of(System.getProperty("user.dir")).toAbsolutePath();
        for (Path dir = at; dir != null; dir = dir.getParent()) {
            if (Files.isDirectory(dir.resolve("packages/pdf-kernel/tests/fixtures"))) {
                return dir;
            }
        }
        throw new IllegalStateException("Not inside the datum monorepo: " + at);
    }

    /** A file of {@code packages/pdf-kernel/tests/fixtures/}. */
    public static byte[] kernelFixture(String relative) {
        try {
            return Files.readAllBytes(repo().resolve("packages/pdf-kernel/tests/fixtures").resolve(relative));
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    public static JsonNode kernelJson(String relative) {
        return JSON.readTree(kernelFixture(relative));
    }

    public static String signingPem(String file) {
        return new String(kernelFixture("signing/" + file), StandardCharsets.US_ASCII);
    }

    /**
     * A signing fixture's key and chain: {@code rsa2048}, {@code p256}, {@code p384}, {@code chain-leaf} (with
     * {@code demo-ca} after it), {@code demo-ca}, {@code tsa}; {@code expired} pairs the RSA key with its 2021 certificate.
     */
    public static TsaKey identity(String name) {
        String key = name.equals("expired") ? "rsa2048" : name;
        String pem = signingPem(name + ".cert.pem") + signingPem(key + ".key.pem");
        if (name.equals("chain-leaf")) {
            pem += signingPem("demo-ca.cert.pem");
        }
        return TsaKey.fromPem(pem);
    }

    public static KeyStorePdfSigner signer(String name) {
        TsaKey key = identity(name);
        return new KeyStorePdfSigner(key.privateKey(), key.chain());
    }

    public static X509Certificate certificate(String name) {
        List<X509Certificate> all = com.argusvane.datum.timestamp.PemCertificates.read(signingPem(name + ".cert.pem"));
        return all.get(0);
    }

    /** The PDF program datum-programs ships, or null when the assets are not built. */
    public static Program pdfProgram() {
        try (InputStream in = TestAssets.class.getClassLoader().getResourceAsStream("META-INF/datum/programs/datum-pdf-program.js")) {
            return in == null ? null : Program.of(Program.Kind.PDF, in.readAllBytes());
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    public static List<X509Certificate> list(X509Certificate... certificates) {
        return new ArrayList<>(List.of(certificates));
    }
}
