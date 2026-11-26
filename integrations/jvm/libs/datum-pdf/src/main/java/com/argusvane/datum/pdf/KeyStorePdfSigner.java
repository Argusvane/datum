package com.argusvane.datum.pdf;

import com.argusvane.datum.timestamp.TsaCertificateRules;
import java.io.IOException;
import java.io.InputStream;
import java.security.GeneralSecurityException;
import java.security.Key;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.Signature;
import java.security.cert.Certificate;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.List;
import java.util.Objects;

/**
 * A {@link PdfSigner} over a private key in {@code java.security}: a PKCS#12 file, any other {@link KeyStore}, or a
 * key already loaded. {@code SHA256withRSA} (PKCS#1 v1.5) for an RSA key, {@code SHA256withECDSA} (DER) for an EC
 * key on P-256 or P-384: the kernel's {@code PdfSignatureAlgorithm}s ({@code x509.ts signatureAlgorithmFor}).
 *
 * <p>Checked once, at construction, so a misconfigured key fails the start rather than the first PDF: the key is
 * one the kernel can describe (RSA of 2048 bits or more, EC P-256 or P-384, as
 * {@link TsaCertificateRules#algorithm} reads the certificate), and it signs a probe the leaf certificate's key
 * verifies (the key belongs to the certificate; a mismatched key store fails the start, not the first seal). Each
 * signature is then
 * made for the algorithm the handoff names, and refused when the key is not of that kind.
 */
public final class KeyStorePdfSigner implements PdfSigner {

    private final PrivateKey key;
    private final List<X509Certificate> chain;
    private final String algorithm;

    /**
     * @param key the private key
     * @param chain the certificate chain, leaf first
     * @throws IllegalArgumentException when the chain is empty, the key is of a kind the kernel cannot use, or it is
     *     not the leaf certificate's
     */
    public KeyStorePdfSigner(PrivateKey key, List<X509Certificate> chain) {
        this.key = Objects.requireNonNull(key, "key");
        Objects.requireNonNull(chain, "chain");
        if (chain.isEmpty() || chain.stream().anyMatch(Objects::isNull)) {
            throw new IllegalArgumentException("The PDF signing key has no certificate chain.");
        }
        this.chain = List.copyOf(chain);
        this.algorithm = TsaCertificateRules.algorithm(this.chain.get(0));
        if (algorithm == null) {
            throw new IllegalArgumentException("The PDF signing certificate's key (" + TsaCertificateRules.algorithmText(this.chain.get(0))
                + ") is not one PDF signatures use here: RSA of 2048 bits or more, or ECDSA on P-256 or P-384.");
        }
        if (!matches()) {
            throw new IllegalArgumentException("The PDF signing key does not belong to the first certificate of its chain.");
        }
    }

    /**
     * The key under an alias of a key store, with the chain the store holds for it.
     *
     * @param alias the entry, or null for the store's only key entry
     * @throws IllegalArgumentException when there is no such key entry, or none with a certificate chain
     */
    public static KeyStorePdfSigner fromKeyStore(KeyStore store, String alias, char[] keyPassword) {
        Objects.requireNonNull(store, "store");
        try {
            String chosen = alias != null ? alias : onlyKeyAlias(store);
            Key key = store.getKey(chosen, keyPassword);
            if (!(key instanceof PrivateKey privateKey)) {
                throw new IllegalArgumentException("The key store has no private key under the alias \"" + chosen + "\".");
            }
            Certificate[] certificates = store.getCertificateChain(chosen);
            List<X509Certificate> chain = new ArrayList<>();
            for (Certificate certificate : certificates == null ? new Certificate[0] : certificates) {
                if (certificate instanceof X509Certificate x509) {
                    chain.add(x509);
                }
            }
            return new KeyStorePdfSigner(privateKey, chain);
        } catch (GeneralSecurityException e) {
            throw new IllegalArgumentException("The PDF signing key cannot be read from the key store: " + e.getMessage(), e);
        }
    }

    /**
     * A PKCS#12 (or other) key store read from a stream.
     *
     * @param type the store type, {@code PKCS12} when null
     * @param storePassword the store's password
     * @param alias the entry, or null for the only key entry
     * @param keyPassword the key's password, the store's when null
     */
    public static KeyStorePdfSigner load(InputStream in, String type, char[] storePassword, String alias, char[] keyPassword) {
        Objects.requireNonNull(in, "in");
        try {
            KeyStore store = KeyStore.getInstance(type == null || type.isBlank() ? "PKCS12" : type);
            store.load(in, storePassword);
            return fromKeyStore(store, alias, keyPassword != null ? keyPassword : storePassword);
        } catch (GeneralSecurityException | IOException e) {
            throw new IllegalArgumentException("The PDF signing key store cannot be read: " + e.getMessage(), e);
        }
    }

    private static String onlyKeyAlias(KeyStore store) throws GeneralSecurityException {
        String found = null;
        for (Enumeration<String> aliases = store.aliases(); aliases.hasMoreElements(); ) {
            String alias = aliases.nextElement();
            if (store.isKeyEntry(alias)) {
                if (found != null) {
                    throw new IllegalArgumentException("The key store holds more than one key: name the alias (the SSL bundle's key.alias).");
                }
                found = alias;
            }
        }
        if (found == null) {
            throw new IllegalArgumentException("The key store holds no private key.");
        }
        return found;
    }

    @Override
    public List<X509Certificate> chain() {
        return chain;
    }

    /** {@code RSA-<bits>}, {@code EC-P256} or {@code EC-P384}. */
    public String keyAlgorithm() {
        return algorithm;
    }

    @Override
    public byte[] sign(byte[] toBeSigned, String signatureAlgorithm) {
        Objects.requireNonNull(toBeSigned, "toBeSigned");
        String jca = jcaFor(signatureAlgorithm, algorithm);
        try {
            Signature signature = Signature.getInstance(jca);
            signature.initSign(key);
            signature.update(toBeSigned);
            return signature.sign();
        } catch (GeneralSecurityException e) {
            throw PdfException.signature("The server's key could not sign the PDF: " + e.getMessage(), e);
        }
    }

    /**
     * The JCA algorithm for a handoff's {@code signatureAlgorithm} and the key's kind; refuses a mismatch (a kernel
     * that asks RSA of an EC key, or P-384 of a P-256 key, is answered with no value at all).
     */
    static String jcaFor(String signatureAlgorithm, String keyAlgorithm) {
        String wanted = signatureAlgorithm == null ? "" : signatureAlgorithm;
        boolean rsa = keyAlgorithm != null && keyAlgorithm.startsWith("RSA-");
        return switch (wanted) {
            case "RSASSA-PKCS1-v1_5-SHA256" -> {
                if (!rsa) {
                    throw PdfException.signature("The PDF asks for an RSA signature, and the server's key is " + keyAlgorithm + ".");
                }
                yield "SHA256withRSA";
            }
            case "ECDSA-P256-SHA256", "ECDSA-P384-SHA256" -> {
                String curve = wanted.equals("ECDSA-P256-SHA256") ? "EC-P256" : "EC-P384";
                if (!curve.equals(keyAlgorithm)) {
                    throw PdfException.signature("The PDF asks for " + wanted + ", and the server's key is " + keyAlgorithm + ".");
                }
                // DER, never P1363 ("SHA256withECDSAinP1363Format"): the CMS SignerInfo carries ECDSA-Sig-Value.
                yield "SHA256withECDSA";
            }
            default -> throw PdfException.signature("The PDF asks for a signature algorithm this server does not make: " + wanted + ".");
        };
    }

    private boolean matches() {
        byte[] probe = "datum pdf signing key probe".getBytes(java.nio.charset.StandardCharsets.US_ASCII);
        String jca = algorithm.startsWith("RSA-") ? "SHA256withRSA" : "SHA256withECDSA";
        try {
            Signature signer = Signature.getInstance(jca);
            signer.initSign(key);
            signer.update(probe);
            byte[] value = signer.sign();
            Signature verifier = Signature.getInstance(jca);
            verifier.initVerify(chain.get(0).getPublicKey());
            verifier.update(probe);
            return verifier.verify(value);
        } catch (GeneralSecurityException | RuntimeException e) {
            return false;
        }
    }

    /** Never prints the key. */
    @Override
    public String toString() {
        return "KeyStorePdfSigner[" + algorithm + ", " + chain.get(0).getSubjectX500Principal().getName() + "]";
    }
}
