package com.argusvane.datum.pdf.verify;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.core.contracts.DatumJson;
import com.argusvane.datum.pdf.TestAssets;
import com.argusvane.datum.timestamp.InMemoryTsaLog;
import com.argusvane.datum.timestamp.SelfSignedTsaCertificate;
import com.argusvane.datum.timestamp.TimestampAuthority;
import com.argusvane.datum.timestamp.TimestampToken;
import com.argusvane.datum.timestamp.TsaKey;
import com.argusvane.datum.timestamp.TsaKeyMaterial;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.PrivateKey;
import java.security.Signature;
import java.security.cert.CertStore;
import java.security.cert.CollectionCertStoreParameters;
import java.security.cert.PKIXRevocationChecker;
import java.security.cert.X509CRL;
import java.security.cert.X509Certificate;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Base64;
import java.util.Date;
import java.util.List;
import org.bouncycastle.asn1.x500.X500Name;
import org.bouncycastle.asn1.x509.BasicConstraints;
import org.bouncycastle.asn1.x509.CRLReason;
import org.bouncycastle.asn1.x509.Extension;
import org.bouncycastle.asn1.x509.KeyUsage;
import org.bouncycastle.cert.X509v2CRLBuilder;
import org.bouncycastle.cert.jcajce.JcaX509CRLConverter;
import org.bouncycastle.cert.jcajce.JcaX509CertificateConverter;
import org.bouncycastle.cert.jcajce.JcaX509v3CertificateBuilder;
import org.bouncycastle.operator.jcajce.JcaContentSignerBuilder;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * The trust policy seam: which anchors a chain reaches, revocation through the JDK's PKIX revocation checker, and
 * the time a chain is judged at. The standard policy is the behaviour before the seam (configured anchors, no revocation,
 * now), and every report names the policy it was made under. A chain whose leaf has expired is refused under a policy that
 * judges now, and under a signing-time policy unless a timestamp this server trusts proves the signature was made while
 * the leaf was valid: the signature's own claimed time never does.
 */
class PdfTrustPolicyTest {

    private static final byte[] SIGNED = "the DER signed attributes of a signature".getBytes(StandardCharsets.US_ASCII);
    private static final String SHA256_RSA = "1.2.840.113549.1.1.11";
    private static final String SHA256 = "2.16.840.1.101.3.4.2.1";
    private static final Instant SIGNED_AT = Instant.parse("2020-06-01T00:00:00Z");

    /** A key and its certificate. */
    record Issued(KeyPair keys, X509Certificate certificate) {
    }

    private static KeyPair rsa() throws Exception {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA");
        generator.initialize(2048);
        return generator.generateKeyPair();
    }

    private static Issued certificate(String subject, KeyPair keys, Issued issuer, Instant from, Instant until, boolean ca) throws Exception {
        X500Name name = new X500Name("CN=" + subject);
        X500Name issuerName = issuer == null ? name : new X500Name(issuer.certificate().getSubjectX500Principal().getName());
        PrivateKey signing = issuer == null ? keys.getPrivate() : issuer.keys().getPrivate();
        JcaX509v3CertificateBuilder builder = new JcaX509v3CertificateBuilder(issuerName, BigInteger.valueOf(System.nanoTime()),
            Date.from(from), Date.from(until), name, keys.getPublic());
        builder.addExtension(Extension.basicConstraints, true, new BasicConstraints(ca));
        builder.addExtension(Extension.keyUsage, true, new KeyUsage(ca ? KeyUsage.keyCertSign | KeyUsage.cRLSign : KeyUsage.digitalSignature));
        X509Certificate certificate = new JcaX509CertificateConverter().getCertificate(
            builder.build(new JcaContentSignerBuilder("SHA256withRSA").build(signing)));
        return new Issued(keys, certificate);
    }

    private static final Issued CA;
    private static final Issued EXPIRED;
    private static final Issued CURRENT;
    private static final TsaKey PAST_TSA = SelfSignedTsaCertificate.create("Datum test TSA", 365 * 30,
        Clock.fixed(Instant.parse("2020-01-01T00:00:00Z"), ZoneOffset.UTC));

    static {
        try {
            CA = certificate("Datum test CA", rsa(), null, Instant.parse("2019-01-01T00:00:00Z"), Instant.parse("2045-01-01T00:00:00Z"), true);
            // Valid through 2020 only: expired now, valid when SIGNED_AT says it signed.
            EXPIRED = certificate("Expired signer", rsa(), CA, Instant.parse("2020-01-01T00:00:00Z"), Instant.parse("2021-01-01T00:00:00Z"), false);
            CURRENT = certificate("Current signer", rsa(), CA, Instant.parse("2024-01-01T00:00:00Z"), Instant.parse("2044-01-01T00:00:00Z"), false);
        } catch (Exception e) {
            throw new ExceptionInInitializerError(e);
        }
    }

    private static String b64(byte[] bytes) {
        return Base64.getEncoder().encodeToString(bytes);
    }

    private static byte[] sign(Issued signer) throws Exception {
        Signature signature = Signature.getInstance("SHA256withRSA");
        signature.initSign(signer.keys().getPrivate());
        signature.update(SIGNED);
        return signature.sign();
    }

    /** A signature report as the kernel writes one, claiming SIGNED_AT as its {@code /M}. */
    private static ObjectNode report(Issued signer) throws Exception {
        ObjectNode report = TestAssets.JSON.createObjectNode();
        report.put("field", "Signature1");
        report.put("subFilter", "ETSI.CAdES.detached");
        report.putArray("byteRange").add(0).add(100).add(200).add(50);
        report.put("coversDocument", true);
        report.put("digestMatches", true);
        report.put("certificateMatches", true);
        report.putObject("signer").put("certificate", b64(signer.certificate().getEncoded()));
        report.put("signerSource", "signature");
        ArrayNode certificates = report.putArray("certificates");
        certificates.add(b64(signer.certificate().getEncoded()));
        certificates.add(b64(CA.certificate().getEncoded()));
        report.put("signatureAlgorithm", SHA256_RSA);
        report.put("toBeVerified", b64(SIGNED));
        report.put("signature", b64(sign(signer)));
        report.put("signingTime", SIGNED_AT.toString());
        report.put("details", "signed");
        return report;
    }

    /** The report with a token over its value from an authority whose clock reads SIGNED_AT. */
    private static ObjectNode timestamped(Issued signer) throws Exception {
        ObjectNode report = report(signer);
        Clock past = Clock.fixed(SIGNED_AT, ZoneOffset.UTC);
        TimestampAuthority authority = new TimestampAuthority(TsaKeyMaterial.of(PAST_TSA), null, null, past, new InMemoryTsaLog(past));
        byte[] value = Base64.getDecoder().decode(report.path("signature").asString());
        TimestampToken token = TimestampToken.fromResponse(authority.stamp(value, "sealing"));
        ObjectNode timestamp = report.putObject("timestamp");
        timestamp.put("time", token.genTime().toString());
        timestamp.put("tsa", "CN=Datum test TSA");
        timestamp.put("coversSignature", token.covers(value));
        timestamp.put("token", b64(token.der()));
        timestamp.put("imprintAlgorithm", SHA256);
        timestamp.put("digestAlgorithm", SHA256);
        timestamp.put("toBeVerified", b64("tsa signed attributes".getBytes(StandardCharsets.US_ASCII)));
        timestamp.put("signatureAlgorithm", SHA256_RSA);
        timestamp.put("signature", b64("tsa value".getBytes(StandardCharsets.US_ASCII)));
        timestamp.putObject("signer").put("certificate", b64(PAST_TSA.leaf().getEncoded()));
        timestamp.put("signerSource", "token");
        timestamp.putArray("certificates").add(b64(PAST_TSA.leaf().getEncoded()));
        timestamp.put("messageDigestMatches", true);
        timestamp.put("contentTypeMatches", true);
        timestamp.put("certificateMatches", true);
        return report;
    }

    private static PdfTrust anchored(X509Certificate... anchors) {
        return new PdfTrust(List::of, List.of(), List.of(anchors), List::of, Clock.systemUTC());
    }

    private static PdfVerifier verifier(PdfTrust trust, PdfTrustPolicy policy) {
        return new PdfVerifier(trust, policy, DatumJson.mapper());
    }

    private static PdfTrustPolicy signingTime() {
        return PdfTrustPolicy.builder("signing-time").validationTime(PdfTrustPolicy.ValidationTime.SIGNING_TIME).build();
    }

    // ------------------------------------------------------------------------------------------------------ validation time

    @Test
    void theStandardPolicyRefusesAnExpiredChainAndTheReportNamesIt() throws Exception {
        PdfVerifier standard = new PdfVerifier(anchored(CA.certificate(), PAST_TSA.leaf()), DatumJson.mapper());
        assertThat(standard.policy().name()).isEqualTo("default");
        SignatureVerdict verdict = standard.signature(timestamped(EXPIRED));
        assertThat(verdict.intact()).as("the signature itself holds").isTrue();
        assertThat(verdict.timestamp().trust()).as("the timestamp holds and its authority is anchored").isEqualTo("trusted");
        assertThat(verdict.trust()).as("an expired leaf, judged now").isEqualTo("unknown");
        assertThat(verdict.trustedAt()).as("no chain held: no time is claimed").isNull();
        SignatureVerdict current = standard.signature(report(CURRENT));
        assertThat(current.trust()).as("a leaf valid now chains").isEqualTo("trusted");
        assertThat(Instant.parse(current.trustedAt())).isAfter(Instant.parse("2026-01-01T00:00:00Z"));

        PdfVerification report = standard.complete("abc", 1, completeAnswer(timestamped(EXPIRED)));
        assertThat(report.trustPolicy()).isEqualTo(new PdfTrustPolicy.Summary("default", false, "now"));
        assertThat(DatumJson.mapper().valueToTree(report).path("trustPolicy").path("validationTime").asString()).isEqualTo("now");
    }

    @Test
    void aSigningTimePolicyJudgesTheChainAtTheTimeATrustedTimestampProves() throws Exception {
        PdfVerifier verifier = verifier(anchored(CA.certificate(), PAST_TSA.leaf()), signingTime());
        SignatureVerdict verdict = verifier.signature(timestamped(EXPIRED));
        assertThat(verdict.trust()).isEqualTo("trusted");
        assertThat(Instant.parse(verdict.trustedAt()).getEpochSecond()).isEqualTo(SIGNED_AT.getEpochSecond());
        assertThat(verifier.complete("abc", 1, completeAnswer(timestamped(EXPIRED))).trustPolicy())
            .isEqualTo(new PdfTrustPolicy.Summary("signing-time", false, "signing-time"));
    }

    @Test
    void aSigningTimePolicyStillRefusesAnExpiredChainWithoutAProvenTime() throws Exception {
        // No timestamp: the signature's own /M (SIGNED_AT) is the signer's claim, so the chain is judged now.
        PdfVerifier anchoredBoth = verifier(anchored(CA.certificate(), PAST_TSA.leaf()), signingTime());
        SignatureVerdict claimed = anchoredBoth.signature(report(EXPIRED));
        assertThat(claimed.trust()).isEqualTo("unknown");
        assertThat(claimed.trustedAt()).isNull();

        // A timestamp from an authority nobody here vouches for proves no time.
        SignatureVerdict unknownAuthority = verifier(anchored(CA.certificate()), signingTime()).signature(timestamped(EXPIRED));
        assertThat(unknownAuthority.timestamp().verified()).isTrue();
        assertThat(unknownAuthority.timestamp().trust()).isEqualTo("unknown");
        assertThat(unknownAuthority.trust()).isEqualTo("unknown");

        // A report whose time is not the token's (the program and this host disagree) proves no time either.
        ObjectNode disagreeing = timestamped(EXPIRED);
        ((ObjectNode) disagreeing.get("timestamp")).put("time", "2020-07-01T00:00:00Z");
        assertThat(anchoredBoth.signature(disagreeing).trust()).isEqualTo("unknown");

        // A token that does not cover the signature proves nothing.
        ObjectNode other = timestamped(EXPIRED);
        ((ObjectNode) other.get("timestamp")).put("coversSignature", false);
        assertThat(anchoredBoth.signature(other).trust()).isEqualTo("unknown");
    }

    @Test
    void theAnchorsAreThePolicysWhenItNamesThem() throws Exception {
        PdfTrustPolicy own = PdfTrustPolicy.builder("own anchors").anchors(List.of(CA.certificate())).build();
        assertThat(verifier(anchored(), own).signature(report(CURRENT)).trust()).isEqualTo("trusted");
        assertThat(verifier(anchored(), PdfTrustPolicy.standard()).signature(report(CURRENT)).trust()).isEqualTo("unknown");
        assertThat(verifier(anchored(), own).knownCertificates()).hasSize(1);
        assertThatThrownBy(() -> PdfTrustPolicy.builder(" ")).isInstanceOf(IllegalArgumentException.class);
    }

    // ------------------------------------------------------------------------------------------------------ revocation

    private static X509CRL crl(X509Certificate... revoked) throws Exception {
        return crlAt(Instant.now(), revoked);
    }

    /** A CRL of the CA's issued a day before {@code at}, due again thirty days after it. */
    private static X509CRL crlAt(Instant at, X509Certificate... revoked) throws Exception {
        X509v2CRLBuilder builder = new X509v2CRLBuilder(new X500Name(CA.certificate().getSubjectX500Principal().getName()),
            Date.from(at.minus(Duration.ofDays(1))));
        builder.setNextUpdate(Date.from(at.plus(Duration.ofDays(30))));
        for (X509Certificate certificate : revoked) {
            builder.addCRLEntry(certificate.getSerialNumber(), Date.from(at.minus(Duration.ofHours(1))), CRLReason.keyCompromise);
        }
        return new JcaX509CRLConverter().getCRL(builder.build(new JcaContentSignerBuilder("SHA256withRSA").build(CA.keys().getPrivate())));
    }

    private static PdfTrustPolicy revocation(X509CRL... crls) throws Exception {
        PdfTrustPolicy.Builder builder = PdfTrustPolicy.builder("revocation")
            .revocationChecking(true, PKIXRevocationChecker.Option.PREFER_CRLS, PKIXRevocationChecker.Option.NO_FALLBACK);
        if (crls.length > 0) {
            builder.certStores(List.of(CertStore.getInstance("Collection", new CollectionCertStoreParameters(List.of(crls)))));
        }
        return builder.build();
    }

    @Test
    void revocationCheckingRefusesARevokedLeafThroughTheJdksChecker() throws Exception {
        PdfTrust trust = anchored(CA.certificate());
        assertThat(verifier(trust, PdfTrustPolicy.standard()).signature(report(CURRENT)).trust()).as("off: not asked").isEqualTo("trusted");
        assertThat(verifier(trust, revocation(crl())).signature(report(CURRENT)).trust()).as("a CRL that lists nothing").isEqualTo("trusted");
        assertThat(verifier(trust, revocation(crl(CURRENT.certificate()))).signature(report(CURRENT)).trust()).isEqualTo("unknown");
        PdfVerification report = verifier(trust, revocation(crl())).complete("abc", 1, completeAnswer(report(CURRENT)));
        assertThat(report.trustPolicy()).isEqualTo(new PdfTrustPolicy.Summary("revocation", true, "now"));
    }

    @Test
    void aStatusThatCannotBeLearntIsARefusalNotAPass() throws Exception {
        // No CRL anywhere and no fallback: the JDK cannot tell, and the chain does not hold.
        assertThat(verifier(anchored(CA.certificate()), revocation()).signature(report(CURRENT)).trust()).isEqualTo("unknown");
        // Unless the policy chose the JDK's soft fail.
        PdfTrustPolicy soft = PdfTrustPolicy.builder("soft").revocationChecking(true, PKIXRevocationChecker.Option.PREFER_CRLS,
            PKIXRevocationChecker.Option.NO_FALLBACK, PKIXRevocationChecker.Option.SOFT_FAIL).build();
        assertThat(verifier(anchored(CA.certificate()), soft).signature(report(CURRENT)).trust()).isEqualTo("trusted");
    }

    /**
     * Under a signing-time policy the JDK checks revocation at the proven time too, so it needs revocation data
     * that was valid then (an archived CRL through the policy's cert stores). Today's CRL is not valid at a time years
     * back, and the chain then fails closed: unknown, never trusted. With the CRL that was current at the signing time
     * the chain holds, and a leaf that CRL lists is refused.
     */
    @Test
    void revocationUnderASigningTimePolicyNeedsRevocationDataValidAtThatTime() throws Exception {
        PdfTrust trust = anchored(CA.certificate(), PAST_TSA.leaf());
        PdfTrustPolicy.Builder base = PdfTrustPolicy.builder("archived").validationTime(PdfTrustPolicy.ValidationTime.SIGNING_TIME)
            .revocationChecking(true, PKIXRevocationChecker.Option.PREFER_CRLS, PKIXRevocationChecker.Option.NO_FALLBACK);
        PdfTrustPolicy todays = base.certStores(List.of(CertStore.getInstance("Collection", new CollectionCertStoreParameters(List.of(crl()))))).build();
        SignatureVerdict refused = verifier(trust, todays).signature(timestamped(EXPIRED));
        assertThat(refused.timestamp().trust()).isEqualTo("trusted");
        assertThat(refused.trust()).as("today's CRL says nothing about 2020: fail closed").isEqualTo("unknown");
        assertThat(refused.trustedAt()).isNull();

        PdfTrustPolicy archived = base.certStores(List.of(CertStore.getInstance("Collection",
            new CollectionCertStoreParameters(List.of(crlAt(SIGNED_AT)))))).build();
        SignatureVerdict held = verifier(trust, archived).signature(timestamped(EXPIRED));
        assertThat(held.trust()).as("the CRL current at the signing time").isEqualTo("trusted");
        assertThat(Instant.parse(held.trustedAt()).getEpochSecond()).isEqualTo(SIGNED_AT.getEpochSecond());

        PdfTrustPolicy listed = base.certStores(List.of(CertStore.getInstance("Collection",
            new CollectionCertStoreParameters(List.of(crlAt(SIGNED_AT, EXPIRED.certificate())))))).build();
        assertThat(verifier(trust, listed).signature(timestamped(EXPIRED)).trust()).isEqualTo("unknown");
    }

    /** A {@code verify} answer of one signature report. */
    private static ObjectNode completeAnswer(ObjectNode signature) {
        ObjectNode answer = TestAssets.JSON.createObjectNode();
        answer.putArray("signatures").add(signature);
        return answer;
    }
}
