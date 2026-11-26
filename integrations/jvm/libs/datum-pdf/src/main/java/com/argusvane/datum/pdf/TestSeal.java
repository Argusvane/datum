package com.argusvane.datum.pdf;

import java.math.BigInteger;
import java.security.GeneralSecurityException;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import java.security.spec.ECGenParameterSpec;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Date;
import java.util.List;
import org.bouncycastle.asn1.x500.X500Name;
import org.bouncycastle.asn1.x509.BasicConstraints;
import org.bouncycastle.asn1.x509.Extension;
import org.bouncycastle.asn1.x509.KeyUsage;
import org.bouncycastle.cert.CertIOException;
import org.bouncycastle.cert.jcajce.JcaX509CertificateConverter;
import org.bouncycastle.cert.jcajce.JcaX509ExtensionUtils;
import org.bouncycastle.cert.jcajce.JcaX509v3CertificateBuilder;
import org.bouncycastle.operator.OperatorCreationException;
import org.bouncycastle.operator.jcajce.JcaContentSignerBuilder;

/**
 * The throwaway certificate PDFs of answers that were never submitted are sealed with (the dry run's
 * PDFs).
 *
 * <p>Such a PDF holds whatever the caller typed, so it is never sealed with the server's certificate: a reader would
 * show it as a valid seal of the server. It gets a key and a self-signed certificate made for the request (ECDSA
 * P-256, valid for a day, common name {@link #COMMON_NAME}, {@code CA:FALSE}, {@code digitalSignature} and
 * {@code nonRepudiation}, a subject key identifier), so the layout's signature box and the reader's signature panel
 * can still be previewed; nothing trusts it, and it is neither stored nor remembered.
 */
public final class TestSeal {

    /** The certificate's common name: a reader shows it, so it says what the seal is not. */
    public static final String COMMON_NAME = "Datum test seal - not valid";

    /** The reason a test seal carries. */
    public static final String REASON = "Test PDF, not a submission";

    private static final SecureRandom RANDOM = new SecureRandom();

    private TestSeal() {
    }

    /**
     * A new key and certificate.
     *
     * @throws IllegalStateException when the platform cannot make them (the message says why, for the
     *     "no test certificate could be made: ..." warning)
     */
    public static KeyStorePdfSigner key(Clock clock) {
        try {
            KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
            generator.initialize(new ECGenParameterSpec("secp256r1"), RANDOM);
            KeyPair pair = generator.generateKeyPair();
            X500Name name = new X500Name("CN=" + COMMON_NAME);
            Instant now = clock.instant();
            // A random positive serial of at most 63 bits (RFC 5280 4.1.2.2: positive, at most 20 octets).
            BigInteger serial = new BigInteger(63, RANDOM).max(BigInteger.ONE);
            JcaX509v3CertificateBuilder builder = new JcaX509v3CertificateBuilder(name, serial, Date.from(now),
                Date.from(now.plus(Duration.ofDays(1))), name, pair.getPublic());
            builder.addExtension(Extension.basicConstraints, true, new BasicConstraints(false));
            builder.addExtension(Extension.keyUsage, true, new KeyUsage(KeyUsage.digitalSignature | KeyUsage.nonRepudiation));
            builder.addExtension(Extension.subjectKeyIdentifier, false, new JcaX509ExtensionUtils().createSubjectKeyIdentifier(pair.getPublic()));
            X509Certificate certificate = new JcaX509CertificateConverter()
                .getCertificate(builder.build(new JcaContentSignerBuilder("SHA256withECDSA").build(pair.getPrivate())));
            return new KeyStorePdfSigner(pair.getPrivate(), List.of(certificate));
        } catch (GeneralSecurityException | OperatorCreationException | CertIOException e) {
            throw new IllegalStateException(e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage(), e);
        }
    }
}
