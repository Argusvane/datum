package com.argusvane.datum.timestamp;

import static com.argusvane.datum.timestamp.Fixtures.hex;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.cert.X509Certificate;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import org.bouncycastle.asn1.ASN1Encodable;
import org.bouncycastle.asn1.DERNull;
import org.bouncycastle.asn1.cms.SignerInfo;
import org.bouncycastle.cert.X509CertificateHolder;
import org.bouncycastle.cms.jcajce.JcaSimpleSignerInfoVerifierBuilder;
import org.bouncycastle.tsp.TimeStampRequest;
import org.bouncycastle.tsp.TimeStampResponse;
import org.bouncycastle.tsp.TimeStampToken;
import org.junit.jupiter.api.Test;

/**
 * Tokens: what they carry and that verifiers accept them, the TSTInfo rules (serials, genTime, accuracy, nonce,
 * certificates), the refusals and their order (RFC 3161 section 2.4; the openssl round trips are OpensslRoundTripIT).
 */
class TimestampAuthorityTest {

    private static final byte[] DATA = "A document the server never sees.".getBytes(StandardCharsets.US_ASCII);

    private static TimestampAuthority authority(TsaKey key, String policy, Duration accuracy, Clock clock, TsaSerialAllocator serials) {
        return new TimestampAuthority(TsaKeyMaterial.of(key), policy, accuracy, clock, serials);
    }

    private static TimestampAuthority authority(TsaKey key, Instant now) {
        return authority(key, null, null, Fixtures.clock(now), new InMemoryTsaLog(Fixtures.clock(now), 1000, 1));
    }

    /**
     * Every request shape gets a token a verifier accepts and that answers the request: the imprint, the policy, the
     * nonce by value (a request's INTEGER in a longer form than its shortest is echoed in its shortest: RFC 3161 2.4.2
     * asks for the same value), the certificates only when asked for, genTime and accuracy as stated. Bouncy Castle
     * builds the token (no byte parity with another server).
     */
    @Test
    void everyRequestShapeGetsATokenThatAnswersItAndVerifies() throws Exception {
        TsaKey key = Fixtures.key("tsa");
        Instant now = Fixtures.OCT_5.plusMillis(250);
        record Case(String name, byte[] query, long accuracyMs, String genTime, BigInteger nonce, boolean certificates) {
        }
        List<Case> cases = List.of(
            new Case("the kernel's request", TimestampQuery.forData(DATA), 1000, "20261005120001Z", null, true),
            new Case("a nonce, a policy, SHA-384", TimestampQuery.forData(DATA, "sha384", true, Fixtures.unhex("084dd8f85ca462a3"),
                TimestampAuthority.DEFAULT_POLICY), 1000, "20261005120001Z", new BigInteger("084dd8f85ca462a3", 16), true),
            new Case("no certificate asked for", TimestampQuery.forData(DATA, "sha512", false, null, null), 1000, "20261005120001Z", null, false),
            new Case("milliseconds under a 250 ms accuracy", TimestampQuery.forData(DATA), 250, "20261005120001.25Z", null, true),
            new Case("seconds and milliseconds of accuracy", TimestampQuery.forData(DATA), 1500, "20261005120001Z", null, true),
            new Case("no accuracy stated", TimestampQuery.forData(DATA), 0, "20261005120001Z", null, true),
            new Case("a nonce not in its shortest form", Der.sequence(Der.integer(1),
                Der.sequence(Der.sequence(Der.oid("2.16.840.1.101.3.4.2.1"), Der.nul()), Der.octetString(TimestampQuery.digest("sha256", DATA))),
                Fixtures.unhex("0203000005"), Der.bool(true)), 1000, "20261005120001Z", BigInteger.valueOf(5), true));
        for (Case c : cases) {
            TimestampQuery query = TimestampQuery.parse(c.query());
            TimestampResponse issued = authority(key, null, Duration.ofMillis(c.accuracyMs()), Fixtures.clock(now), entry -> 41).issue(query);
            TimestampToken token = TimestampToken.parse(issued.response());
            assertThat(token.verifyOver(DATA, c.certificates() ? List.of() : List.of(key.leaf())).problem()).as(c.name()).isNull();
            assertThat(token.policy()).as(c.name()).isEqualTo(TimestampAuthority.DEFAULT_POLICY);
            assertThat(token.serial()).as(c.name()).isEqualTo("29");
            assertThat(issued.genTimeText()).as(c.name()).isEqualTo(c.genTime());
            assertThat(token.certificates()).as(c.name()).hasSize(c.certificates() ? 1 : 0);
            TimeStampToken bouncy = new TimeStampResponse(issued.response()).getTimeStampToken();
            assertThat(bouncy.getTimeStampInfo().getNonce()).as(c.name()).isEqualTo(c.nonce());
            assertThat(bouncy.getTimeStampInfo().getMessageImprintDigest()).as(c.name()).isEqualTo(query.hash());
            bouncy.validate(new JcaSimpleSignerInfoVerifierBuilder().build(key.leaf()));
            assertThat(hex(issued.response())).as(c.name()).isEqualTo(hex(Der.sequence(Der.sequence(Der.integer(0)), issued.token())));
        }
    }

    @Test
    void signsWithSha256WithRsaAndNullParametersOrEcdsaWithout() throws Exception {
        SignerInfo rsa = signerInfo(authority(Fixtures.key("rsa-2048"), Fixtures.LATER).issue(TimestampQuery.parse(TimestampQuery.forData(DATA))).token());
        assertThat(rsa.getDigestEncryptionAlgorithm().getAlgorithm().getId()).isEqualTo("1.2.840.113549.1.1.11");
        assertThat(rsa.getDigestEncryptionAlgorithm().getParameters()).isEqualTo(DERNull.INSTANCE);
        assertThat(rsa.getDigestAlgorithm().getAlgorithm().getId()).isEqualTo("2.16.840.1.101.3.4.2.1");
        assertThat(rsa.getDigestAlgorithm().getParameters()).isNull();
        SignerInfo ec = signerInfo(authority(Fixtures.key("ec-p256"), Fixtures.LATER).issue(TimestampQuery.parse(TimestampQuery.forData(DATA))).token());
        assertThat(ec.getDigestEncryptionAlgorithm().getAlgorithm().getId()).isEqualTo("1.2.840.10045.4.3.2");
        assertThat(ec.getDigestEncryptionAlgorithm().getParameters()).isNull();
        // Bouncy Castle's signed attributes: contentType, signingTime, messageDigest, CMSAlgorithmProtection (RFC 6211),
        // and signingCertificateV2; signingTime is the token's genTime in whole seconds, never the system clock's.
        List<String> types = new java.util.ArrayList<>();
        org.bouncycastle.asn1.cms.Time signingTime = null;
        for (ASN1Encodable attribute : ec.getAuthenticatedAttributes()) {
            org.bouncycastle.asn1.cms.Attribute one = org.bouncycastle.asn1.cms.Attribute.getInstance(attribute);
            types.add(one.getAttrType().getId());
            if (one.getAttrType().getId().equals("1.2.840.113549.1.9.5")) {
                signingTime = org.bouncycastle.asn1.cms.Time.getInstance(one.getAttrValues().getObjectAt(0));
            }
        }
        assertThat(types).containsExactlyInAnyOrder("1.2.840.113549.1.9.3", "1.2.840.113549.1.9.5", "1.2.840.113549.1.9.4",
            "1.2.840.113549.1.9.52", "1.2.840.113549.1.9.16.2.47");
        assertThat(signingTime.getDate().toInstant()).isEqualTo(Fixtures.LATER.truncatedTo(java.time.temporal.ChronoUnit.SECONDS));
    }

    @Test
    void bouncyCastleAndTheTokenReaderAcceptTheTokens() throws Exception {
        for (String name : List.of("tsa", "rsa-2048", "ec-p256", "ec-p384")) {
            TsaKey key = Fixtures.key(name);
            byte[] request = TimestampQuery.forData(DATA, "sha256", true, new byte[] {1, 2, 3, 4, 5, 6, 7, 8}, null);
            TimestampResponse issued = authority(key, Instant.now()).issue(TimestampQuery.parse(request));
            TimeStampResponse response = new TimeStampResponse(issued.response());
            // Imprint, nonce, policy and certReq as asked; the ESSCertIDv2 names the signer (issuerSerial included).
            response.validate(new TimeStampRequest(request));
            TimeStampToken token = response.getTimeStampToken();
            token.validate(new JcaSimpleSignerInfoVerifierBuilder().build(key.leaf()));
            assertThat(token.getTimeStampInfo().getNonce()).isEqualTo(new BigInteger(1, new byte[] {1, 2, 3, 4, 5, 6, 7, 8}));
            assertThat(token.getTimeStampInfo().getTsa().getName().toASN1Primitive().getEncoded())
                .isEqualTo(new X509CertificateHolder(key.leaf().getEncoded()).getSubject().getEncoded());
            TimestampToken.Verification verification = TimestampToken.parse(issued.response()).verifyOver(DATA, List.of());
            assertThat(verification.problem()).as(name).isNull();
            assertThat(verification.signer()).isEqualTo(key.leaf());
        }
    }

    @Test
    void serialsIncreaseAndEveryTokenIsLoggedWithNoDocument() {
        InMemoryTsaLog log = new InMemoryTsaLog(Clock.systemUTC(), 1000, 1);
        TsaKey key = Fixtures.key("ec-p256");
        TimestampAuthority authority = authority(key, null, null, Clock.systemUTC(), log);
        for (String algorithm : List.of("sha256", "sha384", "sha512", "sha256", "sha256")) {
            authority.respond(TimestampQuery.forData(DATA, algorithm, true, null, null), null);
        }
        assertThat(log.recent(50)).extracting(TsaLogRecord::serial).containsExactly(5L, 4L, 3L, 2L, 1L);
        assertThat(log.recent(50)).extracting(r -> r.entry().algorithm()).containsExactly("sha256", "sha256", "sha512", "sha384", "sha256");
        TsaLogEntry latest = log.recent(1).get(0).entry();
        assertThat(latest.imprint()).isEqualTo(hex(TimestampQuery.digest("sha256", DATA)));
        assertThat(latest.client()).isNull();
        assertThat(latest.channel()).isEqualTo("http");
        assertThat(latest.policy()).isEqualTo(TimestampAuthority.DEFAULT_POLICY);
        assertThat(latest.fingerprint()).isEqualTo(key.fingerprint());
        TimestampReply reply = authority.respond(TimestampQuery.forData(DATA), "client-7");
        assertThat(TimestampToken.parse(reply.body()).serial()).isEqualTo("06");
        assertThat(log.recent(1).get(0).entry().client()).isEqualTo("client-7");
        assertThat(reply.issued().serial()).isEqualTo(6);
        assertThat(log.count()).isEqualTo(6);
    }

    @Test
    void genTimeCarriesMillisecondsOnlyUnderASecondOfAccuracy() {
        // The kernel fixture's certificate is valid at the instant this test uses (Fixtures.OCT_5); the openssl fixtures start later.
        TsaKey key = Fixtures.key("tsa");
        record Case(long accuracyMs, long millis, String genTime, String accuracy) {
        }
        for (Case c : List.of(
            new Case(250, 250, "20261005120001.25Z", "3004800200fa"),
            new Case(250, 0, "20261005120001Z", "3004800200fa"),
            new Case(250, 7, "20261005120001.007Z", "3004800200fa"),
            new Case(999, 120, "20261005120001.12Z", "3004800203e7"),
            new Case(1000, 250, "20261005120001Z", "3003020101"),
            new Case(1500, 250, "20261005120001Z", "3007020101800201f4"),
            new Case(0, 250, "20261005120001Z", null))) {
            Instant now = Fixtures.OCT_5.plusMillis(c.millis());
            TimestampResponse issued = authority(key, null, Duration.ofMillis(c.accuracyMs()), Fixtures.clock(now), new InMemoryTsaLog(Clock.systemUTC()))
                .issue(TimestampQuery.parse(TimestampQuery.forData(DATA)));
            assertThat(issued.genTimeText()).as("accuracy %d at .%03d", c.accuracyMs(), c.millis()).isEqualTo(c.genTime());
            byte[] tstInfo = tstInfo(issued.token());
            List<Der.Node> fields = Der.children(tstInfo, Der.readAll(tstInfo));
            assertThat(new String(Der.contents(tstInfo, fields.get(4)), StandardCharsets.US_ASCII)).isEqualTo(c.genTime());
            if (c.accuracy() == null) {
                assertThat(fields.get(5).tag()).as("no accuracy").isNotEqualTo(Der.SEQUENCE);
            } else {
                assertThat(hex(Der.raw(tstInfo, fields.get(5)))).isEqualTo(c.accuracy());
            }
        }
    }

    @Test
    void theAccuracyIsClampedToAMinuteAndThePolicyMustBeAnObjectIdentifier() {
        TsaKey key = Fixtures.key("ec-p256");
        assertThat(authority(key, null, Duration.ofHours(1), Clock.systemUTC(), e -> 1).accuracy()).isEqualTo(Duration.ofSeconds(60));
        assertThat(authority(key, null, Duration.ofMillis(-5), Clock.systemUTC(), e -> 1).accuracy()).isEqualTo(Duration.ZERO);
        assertThat(authority(key, " 1.2.3.4 ", null, Clock.systemUTC(), e -> 1).policy()).isEqualTo("1.2.3.4");
        assertThatThrownBy(() -> authority(key, "1.40", null, Clock.systemUTC(), e -> 1)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void noCertificateAskedForNoCertificateCarried() {
        TsaKey key = Fixtures.key("ec-p256");
        TimestampToken bare = TimestampToken.parse(authority(key, Fixtures.LATER)
            .issue(TimestampQuery.parse(TimestampQuery.forData(DATA, "sha256", false, null, null))).token());
        assertThat(bare.certificates()).isEmpty();
        assertThat(bare.verifyOver(DATA, List.of()).problem()).isEqualTo(TimestampToken.Problem.SIGNATURE);
        assertThat(bare.verifyOver(DATA, List.of(key.leaf())).problem()).isNull();
    }

    @Test
    void aForeignPolicyIsRefusedBeforeASerialIsTaken() {
        InMemoryTsaLog log = new InMemoryTsaLog(Clock.systemUTC());
        TimestampAuthority authority = authority(Fixtures.key("ec-p256"), null, null, Clock.systemUTC(), log);
        TimestampReply reply = authority.respond(TimestampQuery.forData(DATA, "sha256", true, null, "1.2.3.4"), null);
        assertThat(reply.status()).isEqualTo(400);
        assertThat(reply.refusal().failInfo()).isEqualTo(TimestampRefusal.FAIL_UNACCEPTED_POLICY);
        assertThat(reply.refusal().message()).isEqualTo("This timestamp server issues tokens under policy " + TimestampAuthority.DEFAULT_POLICY + " only.");
        // The policy the server issues under is taken when asked for.
        assertThat(authority.respond(TimestampQuery.forData(DATA, "sha256", true, null, TimestampAuthority.DEFAULT_POLICY), null).status()).isEqualTo(200);
        assertThat(authority.respond("not a TimeStampReq".getBytes(StandardCharsets.US_ASCII), null).refusal().failInfo())
            .isEqualTo(TimestampRefusal.FAIL_BAD_DATA_FORMAT);
        assertThat(authority.respond(TimestampQuery.forDigest("sha256", new byte[31]), null).status()).isEqualTo(400);
        assertThat(log.count()).as("One serial, for the one token issued").isEqualTo(1);
    }

    @Test
    void noUsableKeyIsASystemFailureAndTakesNoSerial() {
        AtomicInteger allocated = new AtomicInteger();
        TsaSerialAllocator serials = entry -> allocated.incrementAndGet();
        TimestampAuthority missing = new TimestampAuthority(() -> {
            throw new TsaKeyException("The key store holds no private key.");
        }, null, null, Clock.systemUTC(), serials);
        TimestampReply reply = missing.respond(TimestampQuery.forData(DATA), null);
        assertThat(reply.status()).isEqualTo(503);
        assertThat(reply.refusal().failInfo()).isEqualTo(TimestampRefusal.FAIL_SYSTEM_FAILURE);
        assertThat(reply.refusal().message()).isEqualTo("The timestamp server has no usable key.");
        assertThat(hex(reply.body())).isEqualTo(hex(Der.sequence(Der.sequence(Der.integer(2), Der.sequence(Der.utf8("The timestamp server has no usable key.")),
            NamedBits.of(25)))));
        // A certificate Bouncy Castle's generator refuses (its extended key usage not critical): no usable key.
        TsaKey notCritical = Fixtures.key("eku-not-critical");
        assertThat(authority(notCritical, null, null, Clock.systemUTC(), serials).respond(TimestampQuery.forData(DATA), null).refusal().message())
            .isEqualTo("The timestamp server has no usable key.");
        // Checked material: an expired certificate stops the server.
        TimestampAuthority expired = new TimestampAuthority(TsaKeyMaterial.checked(Fixtures.key("ec-p256"), Fixtures.clock(Instant.parse("2200-01-01T00:00:00Z"))),
            null, null, Clock.systemUTC(), serials);
        assertThat(expired.respond(TimestampQuery.forData(DATA), null).status()).isEqualTo(503);
        assertThat(allocated).hasValue(0);
    }

    @Test
    void theKeyIsHeldToTheCertificateRulesWhateverTheMaterial() {
        // The key checks on every token: the authority runs them itself, so material given as is (TsaKeyMaterial.of, a
        // custom SPI) cannot bring an unusable key past it.
        AtomicInteger allocated = new AtomicInteger();
        TsaSerialAllocator serials = entry -> allocated.incrementAndGet();
        TsaKey p256 = Fixtures.key("ec-p256");
        record Case(String name, TsaKey key, Instant now) {
        }
        for (Case c : List.of(
            new Case("RSA under 2048 bits", Fixtures.key("rsa-1024"), Fixtures.LATER),
            new Case("a curve other than P-256 and P-384", Fixtures.key("ec-p521"), Fixtures.LATER),
            new Case("expired", p256, Instant.parse("2200-01-01T00:00:00Z")),
            new Case("not valid yet", p256, Instant.parse("2026-10-01T00:00:00Z")),
            new Case("timeStamping and another usage", Fixtures.key("eku-extra"), Fixtures.LATER),
            new Case("no extended key usage", Fixtures.key("no-eku"), Fixtures.LATER),
            new Case("a private key that is not the certificate's", new TsaKey(Fixtures.key("ec-p384").privateKey(), p256.chain()), Fixtures.LATER))) {
            TimestampReply reply = new TimestampAuthority(TsaKeyMaterial.of(c.key()), null, null, Fixtures.clock(c.now()), serials)
                .respond(TimestampQuery.forData(DATA), null);
            assertThat(reply.status()).as(c.name()).isEqualTo(503);
            assertThat(reply.refusal().message()).as(c.name()).isEqualTo("The timestamp server has no usable key.");
        }
        assertThat(allocated).as("No serial is taken for an unusable key").hasValue(0);
        // The same key inside its validity issues.
        assertThat(new TimestampAuthority(TsaKeyMaterial.of(p256), null, null, Fixtures.clock(Fixtures.LATER), serials)
            .respond(TimestampQuery.forData(DATA), null).status()).isEqualTo(200);
    }

    @Test
    void aChainIsCarriedLeafFirstAsTheKeyGivesIt() throws Exception {
        TestCertificates.Chain chain = TestCertificates.rsaChain();
        TsaKey key = chain.key();
        assertThat(key.chain()).containsExactly(key.leaf(), chain.intermediate(), chain.root());
        Instant now = Fixtures.OCT_5.plusMillis(250);
        for (boolean certReq : List.of(true, false)) {
            TimestampQuery query = TimestampQuery.parse(TimestampQuery.forData(DATA, "sha256", certReq, new byte[] {5, 6}, null));
            TimestampResponse issued = authority(key, null, Duration.ofMillis(250), Fixtures.clock(now), entry -> 77).issue(query);
            TimestampToken token = TimestampToken.parse(issued.response());
            assertThat(token.certificates()).as("certReq " + certReq).isEqualTo(certReq ? key.chain() : List.of());
            assertThat(token.verifyOver(DATA, List.of(key.leaf())).problem()).isNull();
        }
    }

    @Test
    void aCertificateThatIsNotStrictDerIsCarriedAsGiven() throws Exception {
        // Its critical BOOLEAN written 01: Bouncy Castle carries it byte for byte (no DER pass over the token), so
        // its signature and its ESSCertIDv2 hash hold.
        TsaKey key = TestCertificates.berBoolean();
        byte[] given = key.leaf().getEncoded();
        assertThat(hex(new X509CertificateHolder(given).toASN1Structure().getEncoded("DER"))).as("the certificate is not DER").isNotEqualTo(hex(given));
        TimestampQuery query = TimestampQuery.parse(TimestampQuery.forData(DATA));
        TimestampResponse issued = authority(key, Fixtures.LATER).issue(query);
        TimestampToken token = TimestampToken.parse(issued.response());
        assertThat(hex(token.certificates().get(0).getEncoded())).isEqualTo(hex(given));
        token.certificates().get(0).verify(key.leaf().getPublicKey());
        assertThat(token.verifyOver(DATA, List.of()).problem()).isNull();
        assertThat(token.verifyOver(DATA, List.of()).signer().getEncoded()).isEqualTo(given);
        // The guard every token passes after signing: the same token run through a DER pass is refused.
        byte[] derPass = org.bouncycastle.asn1.cms.ContentInfo.getInstance(issued.token()).getEncoded("DER");
        assertThatThrownBy(() -> TimestampAuthority.checkIssued(derPass, query, key, new TsaCertificate(given)))
            .isInstanceOf(IllegalStateException.class).hasMessage("the token does not carry the certificates as given");
        TimestampAuthority.checkIssued(issued.token(), query, key, new TsaCertificate(given));
    }

    @Test
    void aNameBouncyCastleWouldReSortIsNoUsableKey() throws Exception {
        // A multi-valued RDN whose SET is not in DER order: Bouncy Castle would write the signer's issuer, the
        // ESSCertIDv2 and the tsa name sorted, not as the certificate has them (the kernel matches the signer by
        // those bytes). Refused before a serial is taken.
        TsaKey key = TestCertificates.unsortedRdn();
        byte[] subject = new TsaCertificate(key.leaf().getEncoded()).subject();
        assertThat(hex(org.bouncycastle.asn1.x500.X500Name.getInstance(subject).getEncoded("DER"))).as("the name is not DER").isNotEqualTo(hex(subject));
        assertThat(TsaCertificateRules.problem(key.leaf(), Fixtures.LATER)).isEmpty();
        AtomicInteger allocated = new AtomicInteger();
        TimestampReply reply = new TimestampAuthority(TsaKeyMaterial.of(key), null, null, Fixtures.clock(Fixtures.LATER), entry -> allocated.incrementAndGet())
            .respond(TimestampQuery.forData(DATA), null);
        assertThat(reply.status()).isEqualTo(503);
        assertThat(reply.refusal().message()).isEqualTo("The timestamp server has no usable key.");
        assertThat(allocated).hasValue(0);
    }

    @Test
    void signingThatFailsAfterTheSerialIsTakenSpendsTheSerial() throws Exception {
        TsaKey real = Fixtures.key("tsa");
        TsaKey flaky = new TsaKey(new FlakySigning.Key(real.privateKey()), real.chain());
        java.util.concurrent.atomic.AtomicLong next = new java.util.concurrent.atomic.AtomicLong();
        TsaSerialAllocator serials = entry -> {
            long serial = next.incrementAndGet();
            // The first token's signature fails once its serial is taken.
            FlakySigning.FAIL.set(serial == 1);
            return serial;
        };
        try (AutoCloseable installed = FlakySigning.install()) {
            TimestampAuthority authority = authority(flaky, null, null, Fixtures.clock(Fixtures.OCT_5), serials);
            assertThatThrownBy(() -> authority.issue(TimestampQuery.parse(TimestampQuery.forData(DATA))))
                .isInstanceOfSatisfying(TimestampRefusedException.class, e -> {
                    assertThat(e.failInfo()).isEqualTo(TimestampRefusal.FAIL_SYSTEM_FAILURE);
                    assertThat(e.getMessage()).isEqualTo("The timestamp server cannot sign now.");
                    assertThat(e.httpStatus()).isEqualTo(503);
                });
            assertThat(next).as("the serial was taken before signing").hasValue(1);
            // The next token gets the next serial: the failed one is never reused.
            TimestampResponse issued = authority.issue(TimestampQuery.parse(TimestampQuery.forData(DATA)));
            assertThat(issued.serial()).isEqualTo(2);
            assertThat(TimestampToken.parse(issued.response()).serial()).isEqualTo("02");
            assertThat(TimestampToken.parse(issued.response()).verifyOver(DATA, List.of()).problem()).isNull();
        }
    }

    @Test
    void anInMemoryLogStartsAboveAnEarlierProcessesSerials() {
        Instant start = Fixtures.OCT_5;
        InMemoryTsaLog first = new InMemoryTsaLog(Fixtures.clock(start));
        long last = 0;
        for (int i = 0; i < 5; i++) {
            last = first.allocate(new TsaLogEntry("t", "sha256", "00", "1.2", "f", null, "http"));
        }
        // A restart a second later: a new log, above every serial the first could reach at under 1000 a millisecond.
        InMemoryTsaLog restarted = new InMemoryTsaLog(Fixtures.clock(start.plusSeconds(1)));
        long next = restarted.allocate(new TsaLogEntry("t", "sha256", "00", "1.2", "f", null, "http"));
        assertThat(next).isGreaterThan(last + 999_000);
        assertThat(new InMemoryTsaLog(Clock.systemUTC(), 10, 1).allocate(new TsaLogEntry("t", "sha256", "00", "1.2", "f", null, "http"))).isEqualTo(1);
        assertThatThrownBy(() -> new InMemoryTsaLog(Clock.systemUTC(), 10, 0)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void noSerialIsASystemFailure() {
        TimestampAuthority authority = authority(Fixtures.key("ec-p256"), null, null, Clock.systemUTC(), entry -> {
            throw new IllegalStateException("the database is gone");
        });
        assertThatThrownBy(() -> authority.issue(TimestampQuery.parse(TimestampQuery.forData(DATA))))
            .isInstanceOfSatisfying(TimestampRefusedException.class, e -> {
                assertThat(e.failInfo()).isEqualTo(TimestampRefusal.FAIL_SYSTEM_FAILURE);
                assertThat(e.getMessage()).isEqualTo("The timestamp server cannot issue tokens now.");
                assertThat(e.httpStatus()).isEqualTo(503);
            });
        TimestampAuthority zero = authority(Fixtures.key("ec-p256"), null, null, Clock.systemUTC(), entry -> 0);
        assertThatThrownBy(() -> zero.issue(TimestampQuery.parse(TimestampQuery.forData(DATA)))).hasMessage("The timestamp server cannot issue tokens now.");
    }

    @Test
    void stampsDataForTheHostItself() {
        InMemoryTsaLog log = new InMemoryTsaLog(Clock.systemUTC());
        TsaKey key = Fixtures.key("ec-p256");
        byte[] reply = authority(key, null, null, Clock.systemUTC(), log).stamp(DATA, "receipt");
        assertThat(TimestampClient.granted(reply)).isTrue();
        TimestampToken token = TimestampToken.fromResponse(reply);
        assertThat(token.covers(DATA)).isTrue();
        assertThat(token.certificates()).containsExactly(key.leaf());
        assertThat(log.recent(1).get(0).entry().channel()).isEqualTo("receipt");
    }

    @Test
    void aSelfSignedCertificateIssuesTokens() {
        TsaKey key = SelfSignedTsaCertificate.create("Example timestamp server (test)");
        assertThat(TsaCertificateRules.problem(key.leaf(), Instant.now())).isEmpty();
        assertThat(TsaCertificateRules.algorithm(key.leaf())).isEqualTo("EC-P256");
        TimestampResponse issued = authority(key, Instant.now()).issue(TimestampQuery.parse(TimestampQuery.forData(DATA)));
        TimestampToken token = TimestampToken.parse(issued.response());
        assertThat(token.verifyOver(DATA, List.of()).problem()).isNull();
        X509Certificate leaf = key.leaf();
        assertThat(leaf.getSubjectX500Principal().getName()).isEqualTo("CN=Example timestamp server (test)");
        assertThat(leaf.getNotAfter().toInstant()).isAfter(Instant.now().plus(Duration.ofDays(364)));
        assertThat(leaf.getBasicConstraints()).isEqualTo(-1);
    }

    private static SignerInfo signerInfo(byte[] token) {
        org.bouncycastle.asn1.cms.SignedData signedData = org.bouncycastle.asn1.cms.SignedData.getInstance(
            org.bouncycastle.asn1.cms.ContentInfo.getInstance(token).getContent());
        return SignerInfo.getInstance(signedData.getSignerInfos().getObjectAt(0));
    }

    static byte[] tstInfo(byte[] token) {
        org.bouncycastle.asn1.cms.SignedData signedData = org.bouncycastle.asn1.cms.SignedData.getInstance(
            org.bouncycastle.asn1.cms.ContentInfo.getInstance(token).getContent());
        return org.bouncycastle.asn1.ASN1OctetString.getInstance(signedData.getEncapContentInfo().getContent()).getOctets();
    }

    /** {@code datum.tsa.accepted-policies}: the issuing policy plus the listed ones; the token names the one asked for. */
    @Test
    void aListedPolicyIsAcceptedAndNamedInTheToken() throws Exception {
        InMemoryTsaLog log = new InMemoryTsaLog(Fixtures.clock(Fixtures.LATER), 1000, 1);
        TimestampAuthority authority = new TimestampAuthority(TsaKeyMaterial.of(Fixtures.key("ec-p256")), null, null,
            TsaTimeSource.of(Fixtures.clock(Fixtures.LATER)), log, List.of("1.2.3.5", " ", "1.2.3.5"));
        assertThat(authority.acceptedPolicies()).containsExactly(TimestampAuthority.DEFAULT_POLICY, "1.2.3.5");

        TimestampReply listed = authority.respond(TimestampQuery.forData(DATA, "sha256", true, null, "1.2.3.5"), null);
        assertThat(listed.status()).isEqualTo(200);
        assertThat(listed.issued().policy()).isEqualTo("1.2.3.5");
        assertThat(TimestampToken.parse(listed.body()).policy()).isEqualTo("1.2.3.5");
        assertThat(authority.respond(TimestampQuery.forData(DATA, "sha256", true, null, TimestampAuthority.DEFAULT_POLICY), null).status())
            .isEqualTo(200);
        assertThat(authority.respond(TimestampQuery.forData(DATA), null).issued().policy()).isEqualTo(TimestampAuthority.DEFAULT_POLICY);

        TimestampReply other = authority.respond(TimestampQuery.forData(DATA, "sha256", true, null, "1.2.3.6"), null);
        assertThat(other.status()).isEqualTo(400);
        assertThat(other.refusal().failInfo()).isEqualTo(TimestampRefusal.FAIL_UNACCEPTED_POLICY);
        assertThat(other.refusal().message()).isEqualTo("This timestamp server issues tokens under the policies "
            + TimestampAuthority.DEFAULT_POLICY + ", 1.2.3.5 only.");
    }

    @Test
    void anAcceptedPolicyThatIsNoObjectIdentifierStopsTheConstruction() {
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> new TimestampAuthority(TsaKeyMaterial.of(Fixtures.key("ec-p256")), null, null,
            TsaTimeSource.of(Fixtures.clock(Fixtures.LATER)), entry -> 1, List.of("not-an-oid")))
            .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("not-an-oid");
    }
}
