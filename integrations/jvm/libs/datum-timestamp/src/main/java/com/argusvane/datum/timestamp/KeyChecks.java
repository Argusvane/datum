package com.argusvane.datum.timestamp;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.PrivateKey;
import java.security.Signature;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.List;

/** Key and certificate checks shared by the key loaders: the key is its certificate's, the chain leaf first. */
final class KeyChecks {

    private KeyChecks() {
    }

    /** The JCA signature algorithm the token is signed with for a key: SHA-256 with RSA or ECDSA, else {@code null}. */
    static String signatureAlgorithm(PrivateKey key) {
        return switch (key.getAlgorithm()) {
            case "RSA" -> "SHA256withRSA";
            case "EC", "ECDSA" -> "SHA256withECDSA";
            default -> null;
        };
    }

    /** Whether the private key is the certificate's: a probe signed with one verifies with the other. */
    static boolean matches(PrivateKey key, X509Certificate certificate) {
        String algorithm = signatureAlgorithm(key);
        if (algorithm == null) {
            return false;
        }
        try {
            byte[] probe = "datum-tsa key check".getBytes(StandardCharsets.US_ASCII);
            Signature signer = Signature.getInstance(algorithm);
            signer.initSign(key);
            signer.update(probe);
            byte[] signature = signer.sign();
            Signature verifier = Signature.getInstance(algorithm);
            verifier.initVerify(certificate.getPublicKey());
            verifier.update(probe);
            return verifier.verify(signature);
        } catch (GeneralSecurityException | RuntimeException e) {
            return false;
        }
    }

    /**
     * The key's certificate first, then its issuers in order; certificates outside the chain are left out.
     *
     * @throws TsaKeyException when no certificate is the key's
     */
    static List<X509Certificate> chain(PrivateKey key, List<X509Certificate> certificates) {
        X509Certificate leaf = null;
        List<X509Certificate> rest = new ArrayList<>();
        for (X509Certificate certificate : certificates) {
            if (leaf == null && matches(key, certificate)) {
                leaf = certificate;
            } else if (rest.stream().noneMatch(seen -> TsaKey.fingerprint(seen).equals(TsaKey.fingerprint(certificate)))) {
                rest.add(certificate);
            }
        }
        if (leaf == null) {
            throw new TsaKeyException("No certificate given is the private key’s: the key and the certificate do not match.");
        }
        List<X509Certificate> chain = new ArrayList<>(List.of(leaf));
        X509Certificate current = leaf;
        String leafPrint = TsaKey.fingerprint(leaf);
        while (!selfSigned(current)) {
            X509Certificate next = null;
            for (X509Certificate candidate : rest) {
                if (!TsaKey.fingerprint(candidate).equals(leafPrint)
                    && current.getIssuerX500Principal().equals(candidate.getSubjectX500Principal())
                    && issuedBy(current, candidate)) {
                    next = candidate;
                    break;
                }
            }
            if (next == null) {
                break;
            }
            rest.remove(next);
            chain.add(next);
            current = next;
        }
        return chain;
    }

    static boolean selfSigned(X509Certificate certificate) {
        return certificate.getSubjectX500Principal().equals(certificate.getIssuerX500Principal()) && issuedBy(certificate, certificate);
    }

    static boolean issuedBy(X509Certificate certificate, X509Certificate issuer) {
        try {
            certificate.verify(issuer.getPublicKey());
            return true;
        } catch (GeneralSecurityException | RuntimeException e) {
            return false;
        }
    }
}
