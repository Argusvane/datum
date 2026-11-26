package com.argusvane.datum.timestamp;

import static com.argusvane.datum.timestamp.Fixtures.hex;
import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

/**
 * The PDF kernel reads the Java-made tokens as the Java reader does: the golden
 * {@code kernel/kernel-parity.golden.json} is what {@code src/test/kernel/kernel-parity.ts} printed when it fed the
 * committed tokens through the kernel's {@code parseTimestampToken} and {@code timestampCovers} and verified the
 * TSA signature over the kernel's {@code toBeVerified} with Node's crypto.
 *
 * <p>To remake the tokens (only when the token layout is meant to change): run this test with
 * {@code -Ddatum.timestamp.writeKernelFixtures=true}, then rerun the script from packages/pdf-kernel:
 * {@code npx vite-node ../../integrations/jvm/libs/datum-timestamp/src/test/kernel/kernel-parity.ts}. The RSA tokens
 * are deterministic (PKCS#1 v1.5, a fixed clock and serial), so this test also holds the generator to the committed
 * bytes; the ECDSA one is randomised and only read.
 */
class KernelParityTest {

    private static final JsonMapper JSON = JsonMapper.builder().build();
    private static final Path RESOURCES = Path.of("src/test/resources/kernel");
    private static final String VALUE = "datum-signature-value";

    private record Case(String file, String key, boolean deterministic, boolean bareToken, String candidate, Supplier<byte[]> make) {
    }

    private static byte[] issue(String key, Instant now, Duration accuracy, long serial, byte[] query, boolean bareToken) {
        TimestampResponse issued = new TimestampAuthority(TsaKeyMaterial.of(Fixtures.key(key)), null, accuracy, Fixtures.clock(now), entry -> serial)
            .issue(TimestampQuery.parse(query));
        return bareToken ? issued.token() : issued.response();
    }

    private static final byte[] DATA = VALUE.getBytes(StandardCharsets.US_ASCII);

    private static final List<Case> CASES = List.of(
        // The kernel's own request (SHA-256, certReq, no nonce) answered by the kernel fixture TSA.
        new Case("rsa-kernel-request.tsr", "tsa", true, false, null,
            () -> issue("tsa", Fixtures.OCT_5, Duration.ofSeconds(1), 100, TimestampQuery.forData(DATA), false)),
        // A nonce, SHA-512, seconds and milliseconds of accuracy, as the bare token.
        new Case("rsa-nonce-sha512.token", "tsa", true, true, null,
            () -> issue("tsa", Fixtures.OCT_5, Duration.ofMillis(1500), 101,
                TimestampQuery.forData(DATA, "sha512", true, Fixtures.unhex("084dd8f85ca462a3"), null), true)),
        // A nonce not in its shortest form, echoed as sent.
        new Case("rsa-long-nonce.tsr", "tsa", true, false, null,
            () -> issue("tsa", Fixtures.OCT_5, Duration.ofSeconds(1), 102, Der.sequence(Der.integer(1),
                Der.sequence(Der.sequence(Der.oid("2.16.840.1.101.3.4.2.1"), Der.nul()), Der.octetString(TimestampQuery.digest("sha256", DATA))),
                Fixtures.unhex("0203000005"), Der.bool(true)), false)),
        // ECDSA P-256, milliseconds in genTime, no certificate asked for: the kernel finds no certificate in it.
        new Case("ec-p256-millis-nocert.tsr", "ec-p256", false, false, "ec-p256.cert.pem",
            () -> issue("ec-p256", Fixtures.LATER.plusMillis(250), Duration.ofMillis(250), 103,
                TimestampQuery.forData(DATA, "sha256", false, new byte[] {0x11, 0x22}, null), false)));

    @Test
    void theDeterministicTokensAreTheCommittedBytes() throws Exception {
        if (Boolean.getBoolean("datum.timestamp.writeKernelFixtures")) {
            write();
        }
        for (Case c : CASES) {
            byte[] committed = resource(c.file());
            if (c.deterministic()) {
                assertThat(hex(c.make().get())).as(c.file()).isEqualTo(hex(committed));
            }
            TimestampToken token = TimestampToken.parse(committed);
            List<java.security.cert.X509Certificate> candidates = c.candidate() == null ? List.of() : List.of(Fixtures.certificate(c.key()));
            assertThat(token.verifyOver(DATA, candidates).problem()).as(c.file()).isNull();
        }
    }

    @Test
    void theKernelReadsThemAsTheJavaReaderDoes() throws Exception {
        JsonNode golden = JSON.readTree(new String(resource("kernel-parity.golden.json"), StandardCharsets.UTF_8));
        assertThat(golden.size()).isEqualTo(CASES.size());
        for (Case c : CASES) {
            JsonNode kernel = golden.get(c.file());
            assertThat(kernel).as(c.file() + " in the golden").isNotNull();
            TimestampToken token = TimestampToken.parse(resource(c.file()));
            // What the kernel read is what the Java reader read.
            assertThat(kernel.get("time").stringValue()).as(c.file()).isEqualTo(token.genTimeText().replaceAll("\\.\\d+Z$", "Z"));
            assertThat(kernel.get("serialHex").stringValue()).isEqualTo(token.serial());
            assertThat(kernel.get("imprintAlgorithm").stringValue()).isEqualTo(Map.of("sha256", "2.16.840.1.101.3.4.2.1",
                "sha384", "2.16.840.1.101.3.4.2.2", "sha512", "2.16.840.1.101.3.4.2.3").get(token.algorithm()));
            assertThat(kernel.get("imprintHex").stringValue()).isEqualTo(hex(token.hash()));
            byte[] nonce = token.nonce();
            if (nonce == null) {
                assertThat(kernel.has("nonceHex")).isFalse();
            } else {
                // The kernel drops one leading zero byte (readIntegerBytes); the rest is the nonce as sent.
                byte[] contents = Der.contents(nonce, Der.readAll(nonce));
                String expected = hex(contents.length > 1 && contents[0] == 0 ? java.util.Arrays.copyOfRange(contents, 1, contents.length) : contents);
                assertThat(kernel.get("nonceHex").stringValue()).isEqualTo(expected);
            }
            // The accuracy the TSTInfo states, read by the kernel as written (seconds, millis, micros; absent parts left out).
            assertThat(accuracyOf(kernel)).as(c.file() + " accuracy").isEqualTo(accuracyOf(AuthorityTstInfo.of(token)));
            assertThat(kernel.get("certificates").intValue()).isEqualTo(token.certificates().size());
            // The kernel names the subject in its encoded order, as the TSTInfo's directoryName carries it.
            assertThat(kernel.get("tsa").stringValue()).isEqualTo(org.bouncycastle.asn1.x500.X500Name.getInstance(
                Fixtures.certificate(c.key()).getSubjectX500Principal().getEncoded()).toString().replace(",", ", "));
            // And it holds: a signer read, the imprint covering the value and nothing else, the TSA signature verifying.
            assertThat(kernel.has("signerProblem")).as(c.file()).isFalse();
            assertThat(kernel.get("coversRight").booleanValue()).isTrue();
            assertThat(kernel.get("coversWrong").booleanValue()).isFalse();
            assertThat(kernel.get("signatureVerifies").booleanValue()).as(c.file()).isTrue();
            assertThat(kernel.get("contentType").stringValue()).isEqualTo("1.2.840.113549.1.9.16.1.4");
            assertThat(kernel.get("messageDigestHex").stringValue()).isEqualTo(hex(sha256(AuthorityTstInfo.of(token))));
            assertThat(kernel.get("essCertId").get("algorithm").stringValue()).isEqualTo("2.16.840.1.101.3.4.2.1");
            assertThat(kernel.get("essCertId").get("hashHex").stringValue()).isEqualTo(hex(sha256(Fixtures.certificate(c.key()).getEncoded())));
            assertThat(kernel.get("digestAlgorithm").stringValue()).isEqualTo("2.16.840.1.101.3.4.2.1");
            assertThat(kernel.get("signatureAlgorithm").stringValue())
                .isEqualTo(c.key().startsWith("ec") ? "1.2.840.10045.4.3.2" : "1.2.840.113549.1.1.11");
            assertThat(kernel.get("hasIssuerSerial").booleanValue()).isTrue();
        }
    }

    /** The kernel's accuracy reading as a map of its parts. */
    private static Map<String, Long> accuracyOf(JsonNode kernel) {
        Map<String, Long> out = new LinkedHashMap<>();
        JsonNode accuracy = kernel.get("accuracy");
        if (accuracy != null) {
            for (String part : List.of("seconds", "millis", "micros")) {
                if (accuracy.has(part)) {
                    out.put(part, accuracy.get(part).longValue());
                }
            }
        }
        return out;
    }

    /** The TSTInfo's Accuracy (the SEQUENCE after genTime, if any) as a map of its parts. */
    private static Map<String, Long> accuracyOf(byte[] tstInfo) {
        Map<String, Long> out = new LinkedHashMap<>();
        List<Der.Node> fields = Der.children(tstInfo, Der.readAll(tstInfo));
        if (fields.size() > 5 && fields.get(5).tag() == Der.SEQUENCE) {
            for (Der.Node part : Der.children(tstInfo, fields.get(5))) {
                String name = switch (part.tag()) {
                    case Der.INTEGER -> "seconds";
                    case 0x80 -> "millis";
                    case 0x81 -> "micros";
                    default -> throw new IllegalStateException("an Accuracy part tagged " + part.tag());
                };
                out.put(name, new java.math.BigInteger(Der.contents(tstInfo, part)).longValueExact());
            }
        }
        return out;
    }

    /** The TSTInfo a token carries (what its messageDigest is the digest of). */
    private static final class AuthorityTstInfo {
        static byte[] of(TimestampToken token) {
            return TimestampAuthorityTest.tstInfo(token.der());
        }
    }

    private static byte[] sha256(byte[] data) throws Exception {
        return MessageDigest.getInstance("SHA-256").digest(data);
    }

    private static byte[] resource(String name) throws IOException {
        try (InputStream in = KernelParityTest.class.getResourceAsStream("/kernel/" + name)) {
            if (in == null) {
                throw new IllegalStateException("No kernel fixture " + name + ": run this test with -Ddatum.timestamp.writeKernelFixtures=true, "
                    + "then src/test/kernel/kernel-parity.ts (see the class comment)");
            }
            return in.readAllBytes();
        }
    }

    /** Writes the tokens and the manifest the kernel script reads. */
    private static void write() throws IOException {
        Files.createDirectories(RESOURCES);
        ArrayNode manifest = JsonNodeFactory.instance.arrayNode();
        Map<String, byte[]> files = new LinkedHashMap<>();
        for (Case c : CASES) {
            files.put(c.file(), c.make().get());
            ObjectNode entry = manifest.addObject();
            entry.put("file", c.file());
            entry.put("value", VALUE);
            entry.put("certificate", c.key() + ".cert.pem");
            entry.put("candidate", c.candidate() != null);
        }
        for (Map.Entry<String, byte[]> file : files.entrySet()) {
            Files.write(RESOURCES.resolve(file.getKey()), file.getValue());
        }
        Files.writeString(RESOURCES.resolve("tokens.json"), JSON.writerWithDefaultPrettyPrinter().writeValueAsString(manifest) + "\n");
    }
}
