package com.argusvane.datum.timestamp;

import java.io.ByteArrayInputStream;
import java.math.BigInteger;
import java.security.GeneralSecurityException;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.SecureRandom;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.security.spec.ECGenParameterSpec;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Date;
import java.util.List;
import org.bouncycastle.asn1.x500.X500NameBuilder;
import org.bouncycastle.asn1.x500.style.BCStyle;
import org.bouncycastle.asn1.x509.BasicConstraints;
import org.bouncycastle.asn1.x509.ExtendedKeyUsage;
import org.bouncycastle.asn1.x509.Extension;
import org.bouncycastle.asn1.x509.KeyPurposeId;
import org.bouncycastle.asn1.x509.KeyUsage;
import org.bouncycastle.cert.X509CertificateHolder;
import org.bouncycastle.cert.jcajce.JcaX509ExtensionUtils;
import org.bouncycastle.cert.jcajce.JcaX509v3CertificateBuilder;
import org.bouncycastle.operator.OperatorCreationException;
import org.bouncycastle.operator.jcajce.JcaContentSignerBuilder;

/**
 * Makes a self-signed timestamp certificate and its key (ECDSA P-256), for development and tests. No client trusts it
 * until it is added as a trust anchor.
 *
 * <p>The certificate is what {@link TsaCertificateRules} and RFC 3161 section 2.3 ask of a TSA: subject CN only (64 characters at
 * most), basicConstraints critical CA:FALSE, keyUsage critical digitalSignature and nonRepudiation,
 * extendedKeyUsage critical timeStamping, a subjectKeyIdentifier (the SHA-1 of the key, openssl's "hash"), a
 * random positive serial, valid from now for the days given, signed ecdsa-with-SHA256.
 */
public final class SelfSignedTsaCertificate {

    private static final SecureRandom RANDOM = new SecureRandom();

    private SelfSignedTsaCertificate() {
    }

    /** A certificate valid for a year from now. */
    public static TsaKey create(String commonName) {
        return create(commonName, 365, Clock.systemUTC());
    }

    /**
     * A certificate valid for the days given, from the clock's now.
     *
     * @throws TsaKeyException when the platform cannot make it
     */
    public static TsaKey create(String commonName, int days, Clock clock) {
        if (days < 1) {
            throw new IllegalArgumentException("A certificate is valid for a day at least.");
        }
        try {
            KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
            generator.initialize(new ECGenParameterSpec("secp256r1"), RANDOM);
            KeyPair pair = generator.generateKeyPair();
            String cn = commonName.codePointCount(0, commonName.length()) > 64
                ? commonName.substring(0, commonName.offsetByCodePoints(0, 64))
                : commonName;
            var subject = new X500NameBuilder(BCStyle.INSTANCE).addRDN(BCStyle.CN, cn).build();
            Instant now = Instant.ofEpochSecond(clock.instant().getEpochSecond());
            BigInteger serial = BigInteger.valueOf(1 + (RANDOM.nextLong() & Long.MAX_VALUE) % (Long.MAX_VALUE - 1));
            JcaX509ExtensionUtils extensions = new JcaX509ExtensionUtils();
            JcaX509v3CertificateBuilder builder = new JcaX509v3CertificateBuilder(subject, serial, Date.from(now),
                Date.from(now.plus(Duration.ofDays(days))), subject, pair.getPublic());
            builder.addExtension(Extension.basicConstraints, true, new BasicConstraints(false));
            builder.addExtension(Extension.keyUsage, true, new KeyUsage(KeyUsage.digitalSignature | KeyUsage.nonRepudiation));
            builder.addExtension(Extension.extendedKeyUsage, true, new ExtendedKeyUsage(KeyPurposeId.id_kp_timeStamping));
            builder.addExtension(Extension.subjectKeyIdentifier, false, extensions.createSubjectKeyIdentifier(pair.getPublic()));
            X509CertificateHolder holder = builder.build(new JcaContentSignerBuilder("SHA256withECDSA").build(pair.getPrivate()));
            X509Certificate certificate = (X509Certificate) CertificateFactory.getInstance("X.509")
                .generateCertificate(new ByteArrayInputStream(holder.getEncoded()));
            return new TsaKey(pair.getPrivate(), List.of(certificate));
        } catch (GeneralSecurityException | OperatorCreationException | java.io.IOException e) {
            throw new TsaKeyException("A self-signed timestamp certificate could not be made: " + e.getMessage(), e);
        }
    }
}
