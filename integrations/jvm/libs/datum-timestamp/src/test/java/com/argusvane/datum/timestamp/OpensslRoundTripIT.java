package com.argusvane.datum.timestamp;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import com.argusvane.datum.core.observation.DatumObservations;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The timestamp server, checked by openssl: requests made by {@code openssl ts -query}, answered by
 * {@link TimestampAuthority#respond}, verified by {@code openssl ts -verify -queryfile -CAfile} and read back by
 * {@code openssl ts -reply -text}: tokens verify, other keys, refusals; the endpoint's statuses, clients and flood are
 * the Spring host's tests.
 *
 * <p>Skipped, with a message, when there is no openssl command.
 */
class OpensslRoundTripIT {

    private static final String OPENSSL_DATA = "A document the server never sees.";

    @TempDir
    Path dir;

    private InMemoryTsaLog log;

    @BeforeAll
    static void needsOpenssl() {
        boolean present;
        try {
            Process process = new ProcessBuilder("openssl", "version").redirectErrorStream(true).start();
            present = process.waitFor(20, TimeUnit.SECONDS) && process.exitValue() == 0;
        } catch (IOException | InterruptedException e) {
            present = false;
        }
        assumeTrue(present, "No openssl command to make and check timestamp requests: OpensslRoundTripIT skipped.");
    }

    @BeforeEach
    void data() throws IOException {
        Files.writeString(dir.resolve("data.txt"), OPENSSL_DATA);
        // Serials from 1, so the tests can read them back (the default seeds them from the clock).
        log = new InMemoryTsaLog(Clock.systemUTC(), 1000, 1);
    }

    // ---- helpers ----------------------------------------------------------------------------------------------

    private record Run(int exit, String output) {
    }

    private Run openssl(boolean succeed, String... arguments) throws Exception {
        List<String> command = new ArrayList<>(List.of("openssl"));
        command.addAll(List.of(arguments));
        Process process = new ProcessBuilder(command).directory(dir.toFile()).redirectErrorStream(true).start();
        String output = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        assertThat(process.waitFor(60, TimeUnit.SECONDS)).isTrue();
        if (succeed) {
            assertThat(process.exitValue()).as(String.join(" ", arguments) + ": " + output).isZero();
        }
        return new Run(process.exitValue(), output);
    }

    private String openssl(String... arguments) throws Exception {
        return openssl(true, arguments).output();
    }

    /** Makes a TSA certificate with openssl (ec or rsa) as tsa.crt; returns the key. */
    private TsaKey tsaKey(String type, String extendedKeyUsage) throws Exception {
        String name = type + "-" + Integer.toHexString(extendedKeyUsage.hashCode());
        List<String> arguments = new ArrayList<>(List.of("req", "-x509", "-newkey"));
        arguments.addAll(type.equals("rsa") ? List.of("rsa:2048") : List.of("ec", "-pkeyopt", "ec_paramgen_curve:prime256v1"));
        arguments.addAll(List.of("-nodes", "-keyout", name + ".key", "-out", name + ".crt", "-days", "30",
            "-subj", "/O=Datum tests/CN=Datum test TSA " + type,
            "-addext", "basicConstraints=critical,CA:FALSE", "-addext", "extendedKeyUsage=" + extendedKeyUsage));
        openssl(arguments.toArray(String[]::new));
        Files.copy(dir.resolve(name + ".crt"), dir.resolve("tsa.crt"), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        return TsaKey.fromPem(Files.readString(dir.resolve(name + ".key")) + Files.readString(dir.resolve(name + ".crt")));
    }

    private TimestampAuthority authority(TsaKey key, String policy, Duration accuracy) {
        return new TimestampAuthority(TsaKeyMaterial.checked(key, Clock.systemUTC()), policy, accuracy, Clock.systemUTC(), log);
    }

    /** Writes a request with openssl: -sha384, -no_nonce, -tspolicy ...; -cert unless "-nocert". */
    private byte[] query(String... options) throws Exception {
        List<String> list = new ArrayList<>(List.of(options));
        boolean cert = !list.remove("-nocert");
        List<String> digest = new ArrayList<>(list.stream().filter(o -> List.of("-sha1", "-sha384", "-sha512").contains(o)).toList());
        list.removeAll(digest);
        if (digest.isEmpty()) {
            digest.add("-sha256");
        }
        List<String> arguments = new ArrayList<>(List.of("ts", "-query", "-data", "data.txt"));
        arguments.addAll(digest);
        arguments.addAll(list);
        if (cert) {
            arguments.add("-cert");
        }
        arguments.addAll(List.of("-out", "q.tsq"));
        openssl(arguments.toArray(String[]::new));
        return Files.readAllBytes(dir.resolve("q.tsq"));
    }

    private String verify(byte[] reply, boolean untrusted) throws Exception {
        Files.write(dir.resolve("r.tsr"), reply);
        List<String> arguments = new ArrayList<>(List.of("ts", "-verify", "-in", "r.tsr", "-queryfile", "q.tsq", "-CAfile", "tsa.crt"));
        if (untrusted) {
            arguments.addAll(List.of("-untrusted", "tsa.crt"));
        }
        return openssl(false, arguments.toArray(String[]::new)).output();
    }

    private String text(byte[] reply) throws Exception {
        Files.write(dir.resolve("r.tsr"), reply);
        return openssl("ts", "-reply", "-in", "r.tsr", "-text");
    }

    /** A reply's PKIStatus and the PKIFailureInfo bits set. */
    private static List<Integer> replyStatus(byte[] reply) {
        Der.Node root = Der.readAll(reply);
        List<Der.Node> info = Der.children(reply, Der.children(reply, root).get(0));
        List<Integer> out = new ArrayList<>(List.of((int) Der.readSmallInteger(reply, info.get(0))));
        for (Der.Node field : info) {
            if (field.tag() == Der.BIT_STRING) {
                byte[] bytes = Der.contents(reply, field);
                for (int i = 0; i < (bytes.length - 1) * 8; i++) {
                    if ((bytes[1 + i / 8] & (0x80 >> (i % 8))) != 0) {
                        out.add(i);
                    }
                }
            }
        }
        return out;
    }

    // ---- tests ----------------------------------------------------------------------------------------------

    @Test
    void tokensOpensslVerifiesNonceSerialsImprintsAndPolicy() throws Exception {
        TsaKey key = tsaKey("ec", "critical,timeStamping");
        TimestampAuthority authority = authority(key, null, null);
        byte[] query = query();
        TimestampReply response = authority.respond(query, null);
        assertThat(response.status()).isEqualTo(200);
        byte[] reply = response.body();
        assertThat(replyStatus(reply)).containsExactly(0);
        assertThat(verify(reply, false)).contains("Verification: OK");
        String text = text(reply);
        assertThat(text).contains("Policy OID: " + TimestampAuthority.DEFAULT_POLICY);
        assertThat(text).contains("Serial number: 0x01");
        assertThat(text).containsPattern("Accuracy: 0x01 seconds");
        assertThat(text).contains("CN=Datum test TSA ec");
        Matcher nonce = Pattern.compile("Nonce: (0x[0-9A-F]+)").matcher(openssl("ts", "-query", "-in", "q.tsq", "-text"));
        assertThat(nonce.find()).isTrue();
        assertThat(text).as("The nonce is echoed.").contains("Nonce: " + nonce.group(1));

        // Serials increase; every token is in the log, with no document.
        authority.respond(query("-sha384"), null);
        assertThat(verify(authority.respond(query("-sha512"), null).body(), false)).contains("Verification: OK");
        authority.respond(query(), null);
        assertThat(text(authority.respond(query(), null).body())).contains("Serial number: 0x05");
        assertThat(log.recent(50)).extracting(TsaLogRecord::serial).containsExactly(5L, 4L, 3L, 2L, 1L);
        assertThat(log.recent(50)).extracting(r -> r.entry().algorithm()).containsExactly("sha256", "sha256", "sha512", "sha384", "sha256");
        assertThat(log.recent(1).get(0).entry().imprint()).isEqualTo(Fixtures.hex(TimestampQuery.digest("sha256", OPENSSL_DATA.getBytes(StandardCharsets.UTF_8))));

        // No certificate asked for: the token carries none, and verifies with the certificate given apart.
        reply = authority.respond(query("-nocert", "-no_nonce"), null).body();
        assertThat(text(reply)).contains("Nonce: unspecified");
        assertThat(verify(reply, true)).contains("Verification: OK");
        assertThat(verify(reply, false)).doesNotContain("Verification: OK");

        // Milliseconds: the policy and accuracy set by the host.
        TimestampAuthority site = authority(key, "1.3.6.1.4.1.99999.7", Duration.ofMillis(250));
        reply = site.respond(query("-tspolicy", "1.3.6.1.4.1.99999.7"), null).body();
        assertThat(verify(reply, false)).contains("Verification: OK");
        text = text(reply);
        assertThat(text).contains("Policy OID: 1.3.6.1.4.1.99999.7");
        assertThat(text).containsPattern("Accuracy: unspecified seconds, 0xFA millis");
    }

    @Test
    void rsaKeysAndTheSelfSignedCertificate() throws Exception {
        TsaKey rsa = tsaKey("rsa", "critical,timeStamping");
        assertThat(verify(authority(rsa, null, null).respond(query(), null).body(), false)).contains("Verification: OK");

        TsaKey self = SelfSignedTsaCertificate.create("Example timestamp server (test)");
        assertThat(TsaCertificateRules.problem(self.leaf(), Instant.now())).isEmpty();
        Files.writeString(dir.resolve("tsa.crt"), self.chainPem());
        byte[] reply = authority(self, null, null).respond(query(), null).body();
        assertThat(verify(reply, false)).contains("Verification: OK");
        assertThat(text(reply)).contains("CN=Example timestamp server (test)");
    }

    @Test
    void theKernelFixtureTsaAndEveryOpensslHashOption() throws Exception {
        // The PDF kernel's fixture certificate (RSA-2048, CN=Datum demo TSA).
        Files.write(dir.resolve("tsa.crt"), Fixtures.bytes("tsa.cert.pem"));
        TimestampAuthority authority = authority(Fixtures.key("tsa"), null, null);
        for (String[] options : List.of(new String[] {}, new String[] {"-sha384"}, new String[] {"-sha512"}, new String[] {"-no_nonce"},
            new String[] {"-sha384", "-no_nonce", "-nocert"}, new String[] {"-tspolicy", TimestampAuthority.DEFAULT_POLICY})) {
            byte[] reply = authority.respond(query(options), null).body();
            boolean untrusted = List.of(options).contains("-nocert");
            assertThat(verify(reply, untrusted)).as(String.join(" ", options)).contains("Verification: OK");
        }
        // The request openssl writes with -sha256 -cert -no_nonce is the one TimestampQuery writes (and the kernel).
        byte[] openssl = query("-no_nonce");
        assertThat(Fixtures.hex(TimestampQuery.forData(OPENSSL_DATA.getBytes(StandardCharsets.UTF_8)))).isEqualTo(Fixtures.hex(openssl));
    }

    @Test
    void refusalsOpensslReadsAsRejections() throws Exception {
        TsaKey key = tsaKey("ec", "critical,timeStamping");
        TimestampAuthority authority = authority(key, null, null);

        TimestampReply sha1 = authority.respond(query("-sha1"), null);
        assertThat(sha1.status()).isEqualTo(400);
        assertThat(replyStatus(sha1.body())).containsExactly(2, TimestampRefusal.FAIL_BAD_ALG);
        String text = text(sha1.body());
        assertThat(text).contains("Rejected").contains("SHA-1 imprints are refused");

        TimestampReply policy = authority.respond(query("-tspolicy", "1.2.3.4"), null);
        assertThat(policy.status()).isEqualTo(400);
        assertThat(replyStatus(policy.body())).containsExactly(2, TimestampRefusal.FAIL_UNACCEPTED_POLICY);
        assertThat(text(policy.body())).contains("Rejected").contains("issues tokens under policy");

        TimestampReply garbage = authority.respond("not a TimeStampReq".getBytes(StandardCharsets.US_ASCII), null);
        assertThat(garbage.status()).isEqualTo(400);
        assertThat(replyStatus(garbage.body())).containsExactly(2, TimestampRefusal.FAIL_BAD_DATA_FORMAT);
        assertThat(text(garbage.body())).contains("Rejected");

        // An extension: none is accepted.
        byte[] withExtension = Der.sequence(Der.integer(1),
            Der.sequence(Der.sequence(Der.oid("2.16.840.1.101.3.4.2.1"), Der.nul()), Der.octetString(Fixtures.repeat(1, 32))),
            Der.tlv(0xa0, Der.sequence(Der.oid("1.2.3.4"), Der.octetString(new byte[0]))));
        assertThat(replyStatus(authority.respond(withExtension, null).body())).containsExactly(2, TimestampRefusal.FAIL_UNACCEPTED_EXTENSION);
        assertThat(text(authority.respond(withExtension, null).body())).contains("Rejected");
        // A digest of the wrong length.
        byte[] shortDigest = Der.sequence(Der.integer(1), Der.sequence(Der.sequence(Der.oid("2.16.840.1.101.3.4.2.1")),
            Der.octetString("short".getBytes(StandardCharsets.US_ASCII))));
        assertThat(replyStatus(authority.respond(shortDigest, null).body())).containsExactly(2, TimestampRefusal.FAIL_BAD_DATA_FORMAT);
        assertThat(log.count()).as("No serial was taken for a refusal.").isZero();

        // No usable key: a system failure, 503.
        TimestampAuthority keyless = new TimestampAuthority(() -> {
            throw new TsaKeyException("The key store holds no private key.");
        }, null, null, Clock.systemUTC(), log);
        TimestampReply failure = keyless.respond(query(), null);
        assertThat(failure.status()).isEqualTo(503);
        assertThat(replyStatus(failure.body())).containsExactly(2, TimestampRefusal.FAIL_SYSTEM_FAILURE);
        assertThat(text(failure.body())).contains("Rejected").contains("no usable key");
        assertThat(authority.respond(query(), null).status()).isEqualTo(200);
    }

    /** A server whose time source is unavailable answers 503 with timeNotAvailable, which the openssl client reads as a rejection. */
    @Test
    void anUnavailableTimeSourceIsARejectionOpensslReads() throws Exception {
        TsaKey key = tsaKey("ec", "critical,timeStamping");
        TimestampAuthority drifting = new TimestampAuthority(TsaKeyMaterial.checked(key, Clock.systemUTC()), null, null,
            () -> TsaTimeSource.Reading.unavailable("the system clock is 5 s from the reference"), log, List.of(), List.of(),
            DatumObservations.none());
        byte[] query = query();
        TimestampReply reply = drifting.respond(query, null);
        assertThat(reply.status()).isEqualTo(503);
        assertThat(replyStatus(reply.body())).containsExactly(2, TimestampRefusal.FAIL_TIME_NOT_AVAILABLE);
        assertThat(text(reply.body())).contains("Rejected").contains("the TSA's time source is not available").contains("5 s from the reference");
        assertThat(verify(reply.body(), false)).doesNotContain("Verification: OK");
        assertThat(log.count()).as("no serial for a refusal").isZero();
    }

    @Test
    void opensslMadeTokensReadAndCheckIncludingAnEssCertIdV1() throws Exception {
        // Another server's tokens, made by openssl ts -reply (an impostor's shape): SHA-256 ESSCertIDv2, then
        // SHA-1 ESSCertID (openssl's default), both read and checked.
        Files.write(dir.resolve("tsa.cert.pem"), Fixtures.bytes("tsa.cert.pem"));
        Files.write(dir.resolve("tsa.key.pem"), Fixtures.bytes("tsa.key.pem"));
        byte[] signature = "a signature value".getBytes(StandardCharsets.US_ASCII);
        Files.write(dir.resolve("q.tsq"), TimestampQuery.forData(signature));
        for (String alg : List.of("sha256", "sha1")) {
            Files.writeString(dir.resolve("tsa.serial"), "01\n");
            String config = Fixtures.text("tsa.cnf").replaceAll("(?m)^dir = .*$", "dir = .").replaceAll("(?m)^ess_cert_id_alg = .*$",
                "ess_cert_id_alg = " + alg);
            Files.writeString(dir.resolve("ts.cnf"), config);
            openssl("ts", "-reply", "-config", "ts.cnf", "-queryfile", "q.tsq", "-out", "r.tsr");
            TimestampToken token = TimestampToken.fromResponse(Files.readAllBytes(dir.resolve("r.tsr")));
            TimestampToken.Verification verification = token.verifyOver(signature, List.of());
            assertThat(verification.problem()).as(alg).isNull();
            assertThat(token.names(Fixtures.certificate("tsa"))).as(alg).isTrue();
        }
    }

    @Test
    void aReceiptStatementVerifiesWithOpensslAndNoDatumCode() throws Exception {
        TsaKey key = tsaKey("ec", "critical,timeStamping");
        ReceiptStatement statement = new ReceiptStatement("petition", "PET-1", 1, Instant.now(), "sha256:abc", null);
        Files.write(dir.resolve("statement.json"), statement.bytes());
        Files.write(dir.resolve("r.tsr"), authority(key, null, null).stamp(statement.bytes(), "receipt"));
        assertThat(openssl(false, "ts", "-verify", "-data", "statement.json", "-in", "r.tsr", "-CAfile", "tsa.crt").output())
            .contains("Verification: OK");
    }

    @Test
    void aThreeCertificateChainVerifiesWithTheIntermediateCarried() throws Exception {
        // Root, intermediate and leaf: the token carries all three (leaf first, as the key gives them), so
        // openssl needs only the root as trust anchor; without certReq, the intermediate and leaf come apart.
        TestCertificates.Chain chain = TestCertificates.rsaChain();
        Files.writeString(dir.resolve("root.crt"), TsaKey.pem(chain.root()));
        Files.writeString(dir.resolve("apart.crt"), TsaKey.pem(chain.key().leaf()) + TsaKey.pem(chain.intermediate()));
        TimestampAuthority authority = authority(chain.key(), null, null);
        byte[] reply = authority.respond(query(), null).body();
        assertThat(TimestampToken.parse(reply).certificates()).hasSize(3);
        assertThat(openssl(false, "ts", "-verify", "-in", write(reply), "-queryfile", "q.tsq", "-CAfile", "root.crt").output())
            .contains("Verification: OK");
        reply = authority.respond(query("-nocert"), null).body();
        assertThat(openssl(false, "ts", "-verify", "-in", write(reply), "-queryfile", "q.tsq", "-CAfile", "root.crt").output())
            .doesNotContain("Verification: OK");
        assertThat(openssl(false, "ts", "-verify", "-in", write(reply), "-queryfile", "q.tsq", "-CAfile", "root.crt", "-untrusted", "apart.crt").output())
            .contains("Verification: OK");
    }

    @Test
    void aCertificateThatIsNotStrictDerIsCarriedAsGivenAndVerifies() throws Exception {
        // Its critical BOOLEAN written 01, not FF: carried byte for byte, so openssl verifies the token against it.
        TsaKey key = TestCertificates.berBoolean();
        Files.writeString(dir.resolve("tsa.crt"), key.chainPem());
        byte[] reply = authority(key, null, null).respond(query(), null).body();
        assertThat(TimestampToken.parse(reply).certificates().get(0).getEncoded()).isEqualTo(key.leaf().getEncoded());
        assertThat(verify(reply, false)).contains("Verification: OK");
    }

    private String write(byte[] reply) throws IOException {
        Files.write(dir.resolve("r.tsr"), reply);
        return "r.tsr";
    }

    @Test
    void certificatesRfc3161DoesNotAllowAreRefused() throws Exception {
        TsaKey extra = tsaKey("ec", "critical,timeStamping,codeSigning");
        assertThat(TsaCertificateRules.problem(extra.leaf(), Instant.now())).hasValueSatisfying(p -> assertThat(p).contains("its only extended key usage"));
        TsaKey notCritical = tsaKey("ec", "timeStamping");
        assertThat(TsaCertificateRules.problem(notCritical.leaf(), Instant.now())).hasValueSatisfying(p -> assertThat(p).contains("critical"));
        // Held to the rules at every use: refused as no usable key.
        assertThat(authority(notCritical, null, null).respond(query(), null).status()).isEqualTo(503);
    }
}
