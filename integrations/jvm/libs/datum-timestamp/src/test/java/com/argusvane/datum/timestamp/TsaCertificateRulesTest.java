package com.argusvane.datum.timestamp;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Instant;
import org.junit.jupiter.api.Test;

/**
 * Certificates that RFC 3161 section 2.3 does not allow are refused for the timestamp server, with their sentences,
 * and keys the PDF kernel does not sign with are refused first.
 */
class TsaCertificateRulesTest {

    private static final Instant NOW = Fixtures.LATER;

    @Test
    void theGoodShapesPass() {
        for (String name : new String[] {"tsa", "ec-p256", "ec-p384", "rsa-2048"}) {
            assertThat(TsaCertificateRules.problem(Fixtures.certificate(name), NOW)).as(name).isEmpty();
        }
        assertThat(TsaCertificateRules.algorithm(Fixtures.certificate("tsa"))).isEqualTo("RSA-2048");
        assertThat(TsaCertificateRules.algorithm(Fixtures.certificate("ec-p256"))).isEqualTo("EC-P256");
        assertThat(TsaCertificateRules.algorithm(Fixtures.certificate("ec-p384"))).isEqualTo("EC-P384");
        assertThat(TsaCertificateRules.algorithmText(Fixtures.certificate("ec-p384"))).isEqualTo("ECDSA P-384");
        assertThat(TsaCertificateRules.algorithmText(Fixtures.certificate("rsa-2048"))).isEqualTo("RSA 2048 bits");
    }

    @Test
    void keysThePdfProgramDoesNotSignWithAreRefused() {
        assertThat(TsaCertificateRules.problem(Fixtures.certificate("rsa-1024"), NOW)).contains(
            "The key is RSA 1024 bits: the PDF program signs with RSA keys of 2048 bits or more and ECDSA keys on P-256 or P-384.");
        assertThat(TsaCertificateRules.problem(Fixtures.certificate("ec-p521"), NOW)).contains(
            "The key is ECDSA secp521r1: the PDF program signs with RSA keys of 2048 bits or more and ECDSA keys on P-256 or P-384.");
        assertThat(TsaCertificateRules.algorithm(Fixtures.certificate("rsa-1024"))).isNull();
    }

    @Test
    void theExtendedKeyUsageIsTimeStampingAloneAndCritical() {
        assertThat(TsaCertificateRules.problem(Fixtures.certificate("eku-extra"), NOW)).contains(
            "A timestamp server’s certificate names timeStamping as its only extended key usage (RFC 3161); this one names Time Stamping, Code Signing.");
        assertThat(TsaCertificateRules.problem(Fixtures.certificate("eku-not-critical"), NOW)).contains(
            "A timestamp server’s certificate marks its extended key usage (timeStamping) critical (RFC 3161); this one does not.");
        assertThat(TsaCertificateRules.problem(Fixtures.certificate("no-eku"), NOW)).contains(
            "A timestamp server’s certificate names the extended key usage timeStamping (RFC 3161); this one names no extended key usage.");
        // The critical flag is read from the DER, as written.
        assertThat(new TsaCertificate(der("eku-not-critical")).extendedKeyUsage())
            .isEqualTo(new TsaCertificate.ExtendedKeyUsage(false, java.util.List.of("1.3.6.1.5.5.7.3.8")));
    }

    @Test
    void theCertificateIsValidAtTheTimeGiven() {
        assertThat(TsaCertificateRules.problem(Fixtures.certificate("ec-p256"), Instant.parse("2200-01-01T00:00:00Z")))
            .contains("The certificate CN=Datum test TSA ec, O=Datum tests expired on 2126-09-21.");
        assertThat(TsaCertificateRules.problem(Fixtures.certificate("tsa"), Instant.parse("2025-01-01T00:00:00Z")))
            .contains("The certificate C=CA, O=Datum, CN=Datum demo TSA is not valid until 2026-01-01.");
        // The key's algorithm is judged first.
        assertThat(TsaCertificateRules.problem(Fixtures.certificate("rsa-1024"), Instant.parse("2200-01-01T00:00:00Z")).orElseThrow())
            .startsWith("The key is RSA 1024 bits");
    }

    @Test
    void readsTheNamesAndSerialAsTheyAreWritten() throws Exception {
        TsaCertificate certificate = new TsaCertificate(der("tsa"));
        var holder = new org.bouncycastle.cert.X509CertificateHolder(der("tsa"));
        assertThat(certificate.subject()).isEqualTo(holder.getSubject().getEncoded());
        assertThat(certificate.issuer()).isEqualTo(holder.getIssuer().getEncoded());
        assertThat(certificate.serial()).isEqualTo(new org.bouncycastle.asn1.ASN1Integer(holder.getSerialNumber()).getEncoded());
    }

    private static byte[] der(String name) {
        try {
            return Fixtures.certificate(name).getEncoded();
        } catch (java.security.cert.CertificateEncodingException e) {
            throw new IllegalStateException(e);
        }
    }
}
