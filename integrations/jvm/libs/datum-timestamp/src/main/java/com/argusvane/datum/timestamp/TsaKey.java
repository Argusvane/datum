package com.argusvane.datum.timestamp;

import java.io.IOException;
import java.io.StringReader;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.PrivateKey;
import java.security.cert.CertificateEncodingException;
import java.security.cert.X509Certificate;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.Objects;
import org.bouncycastle.asn1.pkcs.PrivateKeyInfo;
import org.bouncycastle.openssl.PEMKeyPair;
import org.bouncycastle.openssl.PEMParser;
import org.bouncycastle.openssl.jcajce.JcaPEMKeyConverter;

/**
 * The timestamp server's signing key and its certificate chain, the leaf (the key's own certificate) first and
 * its issuers after, in order.
 *
 * @param privateKey the signing key; never logged, never serialized
 * @param chain the certificates, leaf first; at least one
 */
public record TsaKey(PrivateKey privateKey, List<X509Certificate> chain) {

    public TsaKey {
        Objects.requireNonNull(privateKey, "privateKey");
        chain = List.copyOf(chain);
        if (chain.isEmpty()) {
            throw new IllegalArgumentException("A timestamp server key needs its certificate.");
        }
    }

    /** The key's own certificate. */
    public X509Certificate leaf() {
        return chain.get(0);
    }

    /** The leaf certificate's SHA-256 fingerprint, lowercase hex (what the TSA log records). */
    public String fingerprint() {
        return fingerprint(leaf());
    }

    /** A certificate's SHA-256 fingerprint, lowercase hex. */
    public static String fingerprint(X509Certificate certificate) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(certificate.getEncoded()));
        } catch (NoSuchAlgorithmException | CertificateEncodingException e) {
            throw new IllegalStateException("The certificate cannot be fingerprinted", e);
        }
    }

    /** The chain as PEM, leaf first (what {@code GET /tsa/certificate} serves). */
    public String chainPem() {
        StringBuilder out = new StringBuilder();
        for (X509Certificate certificate : chain) {
            out.append(pem(certificate));
        }
        return out.toString();
    }

    /** One certificate as PEM, 64 characters a line. */
    public static String pem(X509Certificate certificate) {
        try {
            String body = Base64.getMimeEncoder(64, new byte[] {'\n'}).encodeToString(certificate.getEncoded());
            return "-----BEGIN CERTIFICATE-----\n" + body + "\n-----END CERTIFICATE-----\n";
        } catch (CertificateEncodingException e) {
            throw new IllegalStateException("The certificate cannot be encoded", e);
        }
    }

    /** Never prints the key. */
    @Override
    public String toString() {
        return "TsaKey[" + leaf().getSubjectX500Principal().getName() + ", " + chain.size() + " certificate(s)]";
    }

    /**
     * Reads a key and its certificates from PEM text: an unencrypted private key ({@code PRIVATE KEY},
     * {@code RSA PRIVATE KEY} or {@code EC PRIVATE KEY}) and the certificates, in any order; the first
     * certificate is taken as the leaf unless another matches the key's public half.
     *
     * @throws TsaKeyException when there is no key, no certificate, or they cannot be read
     */
    public static TsaKey fromPem(String pem) {
        PrivateKey key = null;
        List<X509Certificate> certificates;
        try {
            certificates = PemCertificates.read(pem);
        } catch (IllegalArgumentException e) {
            throw new TsaKeyException(e.getMessage(), e);
        }
        try (PEMParser parser = new PEMParser(new StringReader(pem))) {
            JcaPEMKeyConverter converter = new JcaPEMKeyConverter();
            Object item;
            while ((item = parser.readObject()) != null) {
                if (item instanceof PEMKeyPair pair && key == null) {
                    key = converter.getKeyPair(pair).getPrivate();
                } else if (item instanceof PrivateKeyInfo info && key == null) {
                    key = converter.getPrivateKey(info);
                }
            }
        } catch (IOException e) {
            throw new TsaKeyException("The PEM text cannot be read: " + e.getMessage(), e);
        }
        if (key == null) {
            throw new TsaKeyException("There is no private key: give it with the certificate (PEM or PKCS#12), or apart.");
        }
        if (certificates.isEmpty()) {
            throw new TsaKeyException("There is no certificate: give the key’s certificate with it.");
        }
        return new TsaKey(key, KeyChecks.chain(key, certificates));
    }
}
