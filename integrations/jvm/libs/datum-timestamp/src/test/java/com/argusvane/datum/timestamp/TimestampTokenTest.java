package com.argusvane.datum.timestamp;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.ByteArrayInputStream;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.time.Clock;
import java.time.Instant;
import java.util.Date;
import java.util.List;
import org.bouncycastle.asn1.x500.X500Name;
import org.bouncycastle.asn1.x509.ExtendedKeyUsage;
import org.bouncycastle.asn1.x509.Extension;
import org.bouncycastle.asn1.x509.KeyPurposeId;
import org.bouncycastle.cert.jcajce.JcaX509v3CertificateBuilder;
import org.bouncycastle.operator.jcajce.JcaContentSignerBuilder;
import org.junit.jupiter.api.Test;

/**
 * Tokens read and checked: the openssl-made reply of the kernel's fixture TSA, the Java-made ones, and forged ones
 * (genTime moved, another server with the same name, no certificate carried), with the verify report's problem codes
 * imprint, signature, binding and time.
 */
class TimestampTokenTest {

    private static final byte[] OPENSSL_DATA = "openssl reply data".getBytes(StandardCharsets.US_ASCII);
    private static final byte[] DATA = "a signature value".getBytes(StandardCharsets.US_ASCII);

    @Test
    void readsTheOpensslMadeReply() {
        byte[] reply = Fixtures.bytes("openssl-reply.tsr");
        TimestampToken token = TimestampToken.parse(reply);
        X509Certificate tsa = Fixtures.certificate("tsa");
        assertThat(token.algorithm()).isEqualTo("sha256");
        assertThat(token.serial()).isEqualTo("02");
        assertThat(token.policy()).isEqualTo("1.3.6.1.4.1.99999.1");
        assertThat(token.certificates()).containsExactly(tsa);
        assertThat(token.genTimeText()).matches("\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z");
        assertThat(token.covers(OPENSSL_DATA)).isTrue();
        assertThat(token.covers(DATA)).isFalse();
        // The nonce openssl ts -query wrote, echoed.
        assertThat(token.nonce()).isEqualTo(TimestampQuery.parse(Fixtures.bytes("openssl-query.tsq")).nonce());
        TimestampToken.Check check = token.check(OPENSSL_DATA, List.of());
        assertThat(check.covers()).isTrue();
        assertThat(check.signature()).isTrue();
        assertThat(check.signer()).isEqualTo(tsa);
        assertThat(token.verifyOver(OPENSSL_DATA, List.of())).isEqualTo(new TimestampToken.Verification(true, tsa, null));
        assertThat(token.names(tsa)).isTrue();
        // The bare token and the reply read the same; the token wraps back into the reply openssl wrote.
        TimestampToken bare = TimestampToken.parse(token.der());
        assertThat(bare.serial()).isEqualTo("02");
        assertThat(TimestampToken.fromResponse(reply).der()).isEqualTo(token.der());
        assertThat(TimestampClient.granted(token.response())).isTrue();
    }

    @Test
    void readsTheJavaMadeToken() {
        TsaKey key = Fixtures.key("tsa");
        TimestampAuthority authority = new TimestampAuthority(TsaKeyMaterial.of(key), null, null, Fixtures.clock(Fixtures.OCT_5.plusMillis(250)),
            entry -> 7);
        TimestampResponse issued = authority.issue(TimestampQuery.parse(TimestampQuery.forData(DATA)));
        TimestampToken token = TimestampToken.parse(issued.response());
        assertThat(token.serial()).isEqualTo("07");
        assertThat(token.genTime()).isEqualTo(Fixtures.OCT_5);
        assertThat(token.genTimeText()).isEqualTo("2026-10-05T12:00:01Z");
        assertThat(token.policy()).isEqualTo(TimestampAuthority.DEFAULT_POLICY);
        assertThat(token.verifyOver(DATA, List.of()).problem()).isNull();
        assertThat(token.nonce()).isNull();
    }

    @Test
    void anImprintOfOtherBytesIsAnImprintProblem() {
        TimestampToken token = TimestampToken.parse(Fixtures.bytes("openssl-reply.tsr"));
        TimestampToken.Verification verification = token.verifyOver(DATA, List.of());
        assertThat(verification.covers()).isFalse();
        assertThat(verification.problem()).isEqualTo(TimestampToken.Problem.IMPRINT);
        assertThat(verification.problem().code()).isEqualTo("imprint");
    }

    @Test
    void aGenTimeMovedBackIsASignatureProblem() {
        // The genuine token with its genTime moved back seven years, in place: the same length, the messageDigest
        // no longer the TSTInfo's.
        byte[] token = TimestampToken.parse(Fixtures.bytes("openssl-reply.tsr")).der();
        TimestampToken genuine = TimestampToken.parse(token);
        String year = genuine.genTimeText().substring(0, 4);
        String earlier = String.valueOf(Integer.parseInt(year) - 7);
        String text = new String(token, StandardCharsets.ISO_8859_1);
        String stamp = year + genuine.genTimeText().substring(5, 7) + genuine.genTimeText().substring(8, 10);
        assertThat(text.indexOf(stamp)).isEqualTo(text.lastIndexOf(stamp)).as("The genTime date appears once.").isPositive();
        byte[] forged = text.replace(stamp, earlier + stamp.substring(4)).getBytes(StandardCharsets.ISO_8859_1);
        TimestampToken read = TimestampToken.parse(forged);
        assertThat(read.genTimeText()).startsWith(earlier);
        TimestampToken.Verification verification = read.verifyOver(OPENSSL_DATA, List.of());
        assertThat(verification.covers()).isTrue();
        assertThat(verification.signer()).isNull();
        assertThat(verification.problem()).isEqualTo(TimestampToken.Problem.SIGNATURE);
        assertThat(read.check(OPENSSL_DATA, List.of()).signature()).isFalse();
    }

    @Test
    void anotherServerWithTheSameNameVerifiesAndIsAnotherSigner() {
        // Its signature holds; who it is, is the caller's to judge, by fingerprint or trust anchor.
        TsaKey impostor = SelfSignedTsaCertificate.create("Datum demo TSA");
        TimestampToken token = TimestampToken.parse(new TimestampAuthority(TsaKeyMaterial.of(impostor), null, null, Clock.systemUTC(), entry -> 1)
            .stamp(DATA, "sealing"));
        TimestampToken.Verification verification = token.verifyOver(DATA, List.of(Fixtures.certificate("tsa")));
        assertThat(verification.problem()).isNull();
        assertThat(TsaKey.fingerprint(verification.signer())).isEqualTo(impostor.fingerprint()).isNotEqualTo(TsaKey.fingerprint(Fixtures.certificate("tsa")));
    }

    @Test
    void noCertificateCarriedIsCheckedWithTheCandidatesGiven() {
        TsaKey key = Fixtures.key("tsa");
        TimestampAuthority authority = new TimestampAuthority(TsaKeyMaterial.of(key), null, null, Clock.systemUTC(), entry -> 3);
        TimestampToken bare = TimestampToken.parse(authority.issue(TimestampQuery.parse(TimestampQuery.forData(DATA, "sha256", false, null, null))).token());
        assertThat(bare.certificates()).isEmpty();
        // Nothing to check with: the signature is unknown, not false.
        assertThat(bare.check(DATA, List.of()).signature()).isNull();
        assertThat(bare.verifyOver(DATA, List.of()).problem()).isEqualTo(TimestampToken.Problem.SIGNATURE);
        // A certificate that is not the signer's: false.
        assertThat(bare.check(DATA, List.of(Fixtures.certificate("ec-p256"))).signature()).isFalse();
        // The host's own certificates: found there.
        assertThat(bare.check(DATA, List.of(Fixtures.certificate("ec-p256"), key.leaf())).signer()).isEqualTo(key.leaf());
        assertThat(bare.verifyOver(DATA, List.of(key.leaf())).problem()).isNull();
    }

    @Test
    void aSignerTheTokenDoesNotNameIsABindingProblem() throws Exception {
        // The same key under another certificate: the signature verifies with it, the signingCertificateV2 names the
        // original.
        TsaKey key = Fixtures.key("tsa");
        X509Certificate twin = twin(key);
        TimestampAuthority authority = new TimestampAuthority(TsaKeyMaterial.of(key), null, null, Clock.systemUTC(), entry -> 4);
        TimestampToken bare = TimestampToken.parse(authority.issue(TimestampQuery.parse(TimestampQuery.forData(DATA, "sha256", false, null, null))).token());
        TimestampToken.Verification verification = bare.verifyOver(DATA, List.of(twin));
        assertThat(verification.signer()).isEqualTo(twin);
        assertThat(verification.problem()).isEqualTo(TimestampToken.Problem.BINDING);
        assertThat(bare.names(twin)).isFalse();
        assertThat(bare.names(key.leaf())).isTrue();
    }

    @Test
    void aGenTimeOutsideTheSignersValidityIsATimeProblem() throws Exception {
        // The kernel fixture's certificate starts after the mid-2025 instant this token claims, so the token is out of it. The
        // authority refuses to issue one (its certificate is held to its validity), so the token is made with Bouncy
        // Castle's generator directly, signed with the same key: what a server with a wrong clock would send.
        TsaKey key = Fixtures.key("tsa");
        Instant before = Instant.parse("2025-06-01T00:00:00Z");
        TimestampAuthority authority = new TimestampAuthority(TsaKeyMaterial.of(key), null, null, Fixtures.clock(before), entry -> 5);
        assertThatThrownBy(() -> authority.stamp(DATA, "sealing")).hasMessage("The timestamp server has no usable key.");
        org.bouncycastle.cms.SignerInfoGenerator signer = new org.bouncycastle.cms.jcajce.JcaSignerInfoGeneratorBuilder(
                new org.bouncycastle.operator.jcajce.JcaDigestCalculatorProviderBuilder().build())
            .build(new org.bouncycastle.operator.jcajce.JcaContentSignerBuilder(KeyChecks.signatureAlgorithm(key.privateKey()))
                .build(key.privateKey()), key.leaf());
        org.bouncycastle.tsp.TimeStampTokenGenerator generator = new org.bouncycastle.tsp.TimeStampTokenGenerator(signer,
            new org.bouncycastle.operator.jcajce.JcaDigestCalculatorProviderBuilder().build()
                .get(new org.bouncycastle.asn1.x509.AlgorithmIdentifier(org.bouncycastle.asn1.nist.NISTObjectIdentifiers.id_sha256)),
            new org.bouncycastle.asn1.ASN1ObjectIdentifier(TimestampAuthority.DEFAULT_POLICY), true);
        generator.addCertificates(new org.bouncycastle.cert.jcajce.JcaCertStore(key.chain()));
        TimestampToken token = TimestampToken.parse(generator.generate(new org.bouncycastle.tsp.TimeStampRequest(TimestampQuery.forData(DATA)),
            java.math.BigInteger.valueOf(5), java.util.Date.from(before)).getEncoded());
        TimestampToken.Verification verification = token.verifyOver(DATA, List.of());
        assertThat(verification.signer()).isEqualTo(key.leaf());
        assertThat(verification.problem()).isEqualTo(TimestampToken.Problem.TIME);
        assertThat(verification.problem().code()).isEqualTo("time");
    }

    @Test
    void refusesWhatIsNotAToken() {
        assertThatThrownBy(() -> TimestampToken.parse("hello".getBytes(StandardCharsets.US_ASCII))).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> TimestampToken.parse(Der.sequence(Der.oid("1.2.3"), Der.explicit(0, Der.sequence()))))
            .hasMessage("Not a CMS SignedData.");
        byte[] rejection = new TimestampRefusal(TimestampRefusal.FAIL_BAD_ALG, "No SHA-1.").toResponse();
        assertThatThrownBy(() -> TimestampToken.parse(rejection)).hasMessage("The reply does not grant a timestamp.");
        assertThatThrownBy(() -> TimestampToken.fromResponse(Der.sequence(Der.sequence(Der.integer(0)))))
            .hasMessage("The reply carries no token.");
    }

    private static X509Certificate twin(TsaKey key) throws Exception {
        X509Certificate leaf = key.leaf();
        JcaX509v3CertificateBuilder builder = new JcaX509v3CertificateBuilder(X500Name.getInstance(leaf.getSubjectX500Principal().getEncoded()),
            BigInteger.valueOf(42), Date.from(Instant.parse("2026-01-01T00:00:00Z")), Date.from(Instant.parse("2126-01-01T00:00:00Z")),
            X500Name.getInstance(leaf.getSubjectX500Principal().getEncoded()), leaf.getPublicKey());
        builder.addExtension(Extension.extendedKeyUsage, true, new ExtendedKeyUsage(KeyPurposeId.id_kp_timeStamping));
        byte[] der = builder.build(new JcaContentSignerBuilder("SHA256withRSA").build(key.privateKey())).getEncoded();
        return (X509Certificate) CertificateFactory.getInstance("X.509").generateCertificate(new ByteArrayInputStream(der));
    }
}
