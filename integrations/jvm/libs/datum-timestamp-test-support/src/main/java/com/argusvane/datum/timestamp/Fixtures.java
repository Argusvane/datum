package com.argusvane.datum.timestamp;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.security.cert.CertificateException;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.HexFormat;

/** The committed test fixtures (src/main/resources/fixtures of datum-timestamp-test-support, made by make-fixtures.sh) and small helpers. */
final class Fixtures {

    /** An instant the kernel fixture's certificate is valid at. */
    static final Instant OCT_5 = Instant.parse("2026-10-05T12:00:01Z");

    /** A time inside every committed fixture certificate's validity (the openssl ones are valid from when they were generated). */
    static final Instant LATER = Instant.parse("2030-01-02T03:04:05Z");

    private Fixtures() {
    }

    static byte[] bytes(String name) {
        try (InputStream in = Fixtures.class.getResourceAsStream("/fixtures/" + name)) {
            if (in == null) {
                throw new IllegalStateException("No fixture " + name + " (run make-fixtures.sh)");
            }
            return in.readAllBytes();
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    static String text(String name) {
        return new String(bytes(name), StandardCharsets.UTF_8);
    }

    /** A key and certificate pair: {@code <name>.key.pem} and {@code <name>.cert.pem}. */
    static TsaKey key(String name) {
        return TsaKey.fromPem(text(name + ".key.pem") + text(name + ".cert.pem"));
    }

    static X509Certificate certificate(String name) {
        try {
            return (X509Certificate) CertificateFactory.getInstance("X.509").generateCertificate(new ByteArrayInputStream(bytes(name + ".cert.pem")));
        } catch (CertificateException e) {
            throw new IllegalStateException(e);
        }
    }

    static Clock clock(Instant instant) {
        return Clock.fixed(instant, ZoneOffset.UTC);
    }

    static String hex(byte[] bytes) {
        return HexFormat.of().formatHex(bytes);
    }

    static byte[] unhex(String hex) {
        return HexFormat.of().parseHex(hex);
    }

    static byte[] repeat(int value, int count) {
        byte[] out = new byte[count];
        java.util.Arrays.fill(out, (byte) value);
        return out;
    }
}
