package com.argusvane.datum.timestamp;

import java.security.PublicKey;
import java.security.cert.CertificateEncodingException;
import java.security.cert.X509Certificate;
import java.security.interfaces.RSAPublicKey;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.bouncycastle.asn1.ASN1Encodable;
import org.bouncycastle.asn1.ASN1ObjectIdentifier;
import org.bouncycastle.asn1.ASN1String;
import org.bouncycastle.asn1.x500.AttributeTypeAndValue;
import org.bouncycastle.asn1.x500.RDN;
import org.bouncycastle.asn1.x500.X500Name;
import org.bouncycastle.asn1.x509.SubjectPublicKeyInfo;

/**
 * What a timestamp server's certificate must be, with a sentence for what it is not.
 *
 * <p>The checks, in this order: the key is one the PDF program signs with (RSA of 2048 bits or more, ECDSA on P-256
 * or P-384: the kernel's signature algorithms); the certificate is valid at the time given; and its extended
 * key usage is exactly id-kp-timeStamping, marked critical, both read from the certificate's DER, as
 * RFC 3161 section 2.3 requires. Each problem is a sentence ending in a full stop, for a log or an admin page.
 */
public final class TsaCertificateRules {

    private static final DateTimeFormatter DAY = DateTimeFormatter.ofPattern("uuuu-MM-dd").withZone(ZoneOffset.UTC);

    private static final String RSA_ENCRYPTION = "1.2.840.113549.1.1.1";
    private static final String EC_PUBLIC_KEY = "1.2.840.10045.2.1";

    /** Curve OIDs as openssl names them, so a message names a curve as an operator's openssl does. */
    private static final Map<String, String> CURVES = Map.of(
        "1.2.840.10045.3.1.7", "prime256v1",
        "1.3.132.0.34", "secp384r1",
        "1.3.132.0.35", "secp521r1",
        "1.3.132.0.10", "secp256k1",
        "1.2.840.10045.3.1.1", "prime192v1",
        "1.3.132.0.33", "secp224r1");

    /** Extended key usages as openssl prints them. */
    private static final Map<String, String> USAGES = Map.of(
        "1.3.6.1.5.5.7.3.1", "TLS Web Server Authentication",
        "1.3.6.1.5.5.7.3.2", "TLS Web Client Authentication",
        "1.3.6.1.5.5.7.3.3", "Code Signing",
        "1.3.6.1.5.5.7.3.4", "E-mail Protection",
        "1.3.6.1.5.5.7.3.8", "Time Stamping",
        "1.3.6.1.5.5.7.3.9", "OCSP Signing",
        "2.5.29.37.0", "Any Extended Key Usage");

    private TsaCertificateRules() {
    }

    /**
     * Why a certificate cannot be a timestamp server's at a time, or empty: the key's algorithm, the validity,
     * then the extended key usage, in that order.
     */
    public static Optional<String> problem(X509Certificate certificate, Instant now) {
        if (algorithm(certificate) == null) {
            return Optional.of("The key is " + algorithmText(certificate)
                + ": the PDF program signs with RSA keys of 2048 bits or more and ECDSA keys on P-256 or P-384.");
        }
        long seconds = now.getEpochSecond();
        long notAfter = certificate.getNotAfter().toInstant().getEpochSecond();
        long notBefore = certificate.getNotBefore().toInstant().getEpochSecond();
        if (notAfter < seconds) {
            return Optional.of("The certificate " + subjectText(certificate) + " expired on " + DAY.format(Instant.ofEpochSecond(notAfter)) + ".");
        }
        if (notBefore > seconds) {
            return Optional.of("The certificate " + subjectText(certificate) + " is not valid until " + DAY.format(Instant.ofEpochSecond(notBefore)) + ".");
        }
        return extendedKeyUsageProblem(certificate);
    }

    /**
     * Why a certificate's extended key usage is not a timestamp server's (RFC 3161 section 2.3), or empty:
     * none named, not timeStamping alone, not critical; or the certificate cannot be read.
     */
    public static Optional<String> extendedKeyUsageProblem(X509Certificate certificate) {
        TsaCertificate.ExtendedKeyUsage usage;
        try {
            usage = new TsaCertificate(certificate.getEncoded()).extendedKeyUsage();
        } catch (IllegalArgumentException | CertificateEncodingException e) {
            return Optional.of("The certificate cannot be read: " + e.getMessage());
        }
        if (usage == null) {
            return Optional.of("A timestamp server’s certificate names the extended key usage timeStamping (RFC 3161); this one names no extended key usage.");
        }
        if (!usage.purposes().equals(List.of(TsaCertificate.TIME_STAMPING))) {
            List<String> names = new ArrayList<>();
            for (String purpose : usage.purposes()) {
                names.add(USAGES.getOrDefault(purpose, purpose));
            }
            return Optional.of("A timestamp server’s certificate names timeStamping as its only extended key usage (RFC 3161); this one names "
                + String.join(", ", names) + ".");
        }
        if (!usage.critical()) {
            return Optional.of("A timestamp server’s certificate marks its extended key usage (timeStamping) critical (RFC 3161); this one does not.");
        }
        return Optional.empty();
    }

    /**
     * The key's algorithm as the PDF kernel signs with it: {@code RSA-<bits>} (2048 bits or more), {@code EC-P256}
     * or {@code EC-P384}; {@code null} for any other key (smaller RSA, other curves, Ed25519, RSA-PSS).
     */
    public static String algorithm(X509Certificate certificate) {
        PublicKey key = certificate.getPublicKey();
        String oid = spkiAlgorithm(key);
        if (RSA_ENCRYPTION.equals(oid) && key instanceof RSAPublicKey rsa) {
            int bits = rsa.getModulus().bitLength();
            return bits >= 2048 ? "RSA-" + bits : null;
        }
        if (EC_PUBLIC_KEY.equals(oid)) {
            String curve = curveOf(key);
            if ("prime256v1".equals(curve)) {
                return "EC-P256";
            }
            if ("secp384r1".equals(curve)) {
                return "EC-P384";
            }
        }
        return null;
    }

    /** The key's algorithm in words, supported or not: {@code RSA 2048 bits}, {@code ECDSA P-256}, {@code ECDSA secp521r1}. */
    public static String algorithmText(X509Certificate certificate) {
        String known = algorithm(certificate);
        if (known != null) {
            return known.startsWith("RSA-") ? "RSA " + known.substring(4) + " bits" : "ECDSA P-" + known.substring(4);
        }
        PublicKey key = certificate.getPublicKey();
        String oid = spkiAlgorithm(key);
        if (RSA_ENCRYPTION.equals(oid) && key instanceof RSAPublicKey rsa) {
            return "RSA " + rsa.getModulus().bitLength() + " bits";
        }
        if (EC_PUBLIC_KEY.equals(oid)) {
            String curve = curveOf(key);
            return "ECDSA " + (curve == null ? "?" : curve);
        }
        return "unknown";
    }

    /** The subject as {@code CN=…, O=…, C=…}, most specific first (RFC 4514's order). */
    public static String subjectText(X509Certificate certificate) {
        return DistinguishedNames.subject(certificate);
    }

    private static String spkiAlgorithm(PublicKey key) {
        try {
            return SubjectPublicKeyInfo.getInstance(key.getEncoded()).getAlgorithm().getAlgorithm().getId();
        } catch (RuntimeException e) {
            return null;
        }
    }

    private static String curveOf(PublicKey key) {
        try {
            ASN1Encodable parameters = SubjectPublicKeyInfo.getInstance(key.getEncoded()).getAlgorithm().getParameters();
            if (parameters instanceof ASN1ObjectIdentifier curve) {
                return CURVES.getOrDefault(curve.getId(), curve.getId());
            }
            return null;
        } catch (RuntimeException e) {
            return null;
        }
    }
}
