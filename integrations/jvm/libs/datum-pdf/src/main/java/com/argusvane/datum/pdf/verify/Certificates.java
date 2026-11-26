package com.argusvane.datum.pdf.verify;

import com.argusvane.datum.timestamp.DistinguishedNames;
import com.argusvane.datum.timestamp.TsaKey;
import java.io.ByteArrayInputStream;
import java.math.BigInteger;
import java.security.cert.CertificateException;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.time.Instant;
import java.util.Base64;
import java.util.Locale;
import org.bouncycastle.asn1.x500.AttributeTypeAndValue;
import org.bouncycastle.asn1.x500.RDN;
import org.bouncycastle.asn1.x500.X500Name;
import org.bouncycastle.asn1.x500.style.BCStyle;

/**
 * Certificates as the verifier reads them, in the verify report's format (endpoint catalog {@code verifyPdf}): subject
 * and issuer as {@code attribute=value} pairs joined by ", " in the reverse of their DER order (the order RFC 4514
 * writes a name in, the most specific first); the common name, the serial in upper-case hex, the validity as Unix
 * seconds, the SHA-256 fingerprint, self-signed.
 */
public final class Certificates {

    private Certificates() {
    }

    /** A DER certificate, or null when the bytes are not one. */
    public static X509Certificate fromDer(byte[] der) {
        if (der == null || der.length == 0) {
            return null;
        }
        try {
            return (X509Certificate) CertificateFactory.getInstance("X.509").generateCertificate(new ByteArrayInputStream(der));
        } catch (CertificateException | RuntimeException e) {
            return null;
        }
    }

    /** A base64 DER certificate, or null (bad base64 included: the JDK's basic decoder refuses it). */
    public static X509Certificate fromBase64(String base64) {
        byte[] der = decode(base64);
        return der == null ? null : fromDer(der);
    }

    /** Strict base64 (no whitespace, no other characters), or null. */
    static byte[] decode(String base64) {
        if (base64 == null) {
            return null;
        }
        try {
            return Base64.getDecoder().decode(base64);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    /** The SHA-256 fingerprint, lowercase hex. */
    public static String fingerprint(X509Certificate certificate) {
        return TsaKey.fingerprint(certificate);
    }

    /** The subject, its attributes in the reverse of their DER order (RFC 4514's order). */
    public static String subject(X509Certificate certificate) {
        return DistinguishedNames.subject(certificate);
    }

    /** The issuer, as {@link #subject} writes a name. */
    public static String issuer(X509Certificate certificate) {
        return DistinguishedNames.issuer(certificate);
    }

    /** The subject's common name, or the whole subject when it has none (the last CN in DER order, the most specific). */
    public static String commonName(X509Certificate certificate) {
        X500Name name = X500Name.getInstance(certificate.getSubjectX500Principal().getEncoded());
        String cn = null;
        for (RDN rdn : name.getRDNs(BCStyle.CN)) {
            for (AttributeTypeAndValue value : rdn.getTypesAndValues()) {
                if (BCStyle.CN.equals(value.getType())) {
                    cn = DistinguishedNames.valueText(value.getValue());
                }
            }
        }
        return cn != null && !cn.isEmpty() ? cn : subject(certificate);
    }

    /** The serial number, upper-case hex. */
    public static String serial(X509Certificate certificate) {
        BigInteger serial = certificate.getSerialNumber();
        String hex = serial.toString(16).toUpperCase(Locale.ROOT);
        return hex.length() % 2 == 1 ? "0" + hex : hex;
    }

    /** When it starts to be valid, Unix seconds. */
    public static long notBefore(X509Certificate certificate) {
        return certificate.getNotBefore().toInstant().getEpochSecond();
    }

    /** When it stops being valid, Unix seconds. */
    public static long notAfter(X509Certificate certificate) {
        return certificate.getNotAfter().toInstant().getEpochSecond();
    }

    /** Whether it is valid at a time: notBefore through notAfter, both ends included (RFC 5280 4.1.2.5). */
    public static boolean validAt(X509Certificate certificate, Instant at) {
        long seconds = at.getEpochSecond();
        return seconds >= notBefore(certificate) && seconds <= notAfter(certificate);
    }

    /** Whether it names itself as its issuer and its own key signed it. */
    public static boolean selfSigned(X509Certificate certificate) {
        if (!subject(certificate).equals(issuer(certificate))) {
            return false;
        }
        try {
            certificate.verify(certificate.getPublicKey());
            return true;
        } catch (Exception e) {
            return false;
        }
    }
}
