package com.argusvane.datum.webauthn;

import com.webauthn4j.data.attestation.authenticator.COSEKey;
import com.webauthn4j.data.attestation.authenticator.Curve;
import com.webauthn4j.data.attestation.authenticator.EC2COSEKey;
import com.webauthn4j.data.attestation.authenticator.RSACOSEKey;
import com.webauthn4j.data.attestation.statement.COSEAlgorithmIdentifier;
import java.math.BigInteger;
import java.security.AlgorithmParameters;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.PublicKey;
import java.security.interfaces.ECPublicKey;
import java.security.interfaces.RSAPublicKey;
import java.security.spec.ECFieldFp;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.ECParameterSpec;
import java.security.spec.ECPoint;
import java.security.spec.X509EncodedKeySpec;

/**
 * This site's key policy for a credential's COSE public key (RFC 9052/9053), and the key as SPKI DER: webauthn4j reads the
 * COSE key and builds the JCA key, this class decides
 * whether it is one this site takes.
 *
 * <p>WebAuthn credentials registered here sign with ES256 (an EC2 key on P-256) or RS256 (an RSA key with a
 * modulus of at least 2048 bits); the key comes out of the attested credential data of the registration's
 * authenticator data, and is kept as SPKI DER together with its COSE algorithm, which is the algorithm every
 * later assertion is checked under (never the one a signed document names: the engine's RS256
 * documents carry {@code -7}).
 */
public final class CoseKey {

    /** COSE algorithm ES256: ECDSA over P-256 with SHA-256. */
    public static final int ES256 = -7;

    /** COSE algorithm RS256: RSASSA-PKCS1-v1_5 with SHA-256. */
    public static final int RS256 = -257;

    private static final ECParameterSpec P256 = p256();

    private CoseKey() {
    }

    /**
     * SPKI DER bytes and the COSE algorithm of a key.
     *
     * @param spki the SubjectPublicKeyInfo DER; copied in and out
     * @param algorithm {@link #ES256} or {@link #RS256}
     */
    public record Spki(byte[] spki, int algorithm) {

        public Spki {
            spki = spki.clone();
        }

        @Override
        public byte[] spki() {
            return spki.clone();
        }
    }

    /**
     * The SPKI DER and algorithm of a credential's COSE key as webauthn4j read it, held to this site's key policy: an EC2
     * key labelled ES256 on P-256 with coordinates of 32 bytes each and a point on the curve, or an RSA key labelled
     * RS256 with a modulus of at least 2048 bits (bits, not bytes: a short modulus padded with zero bytes is still short)
     * and an exponent. The SPKI is the JCA's encoding of the key webauthn4j built ({@code getPublicKey().getEncoded()}),
     * the same bytes as a hand-written DER encoding (pinned by {@code SpkiContinuityTest}), so the
     * stored keys and their hashes, which the duplicate-key refusal reads, do not move.
     *
     * @throws IllegalArgumentException for a key this site does not take: another type, algorithm or curve, a malformed
     *     point or modulus, a key the JCA cannot build
     */
    public static Spki fromCose(COSEKey cose) {
        if (cose instanceof EC2COSEKey ec && isAlgorithm(ec.getAlgorithm(), ES256)) {
            byte[] x = ec.getX();
            byte[] y = ec.getY();
            if (ec.getCurve() != Curve.SECP256R1 || x == null || y == null || x.length != 32 || y.length != 32) {
                throw new IllegalArgumentException("The ES256 key is not a P-256 point.");
            }
            return checked(cose, ES256);
        }
        if (cose instanceof RSACOSEKey rsa && isAlgorithm(rsa.getAlgorithm(), RS256)) {
            byte[] n = rsa.getN();
            byte[] e = rsa.getE();
            if (n == null || e == null || e.length == 0 || new BigInteger(1, n).bitLength() < 2048) {
                throw new IllegalArgumentException("The RS256 key has no modulus of at least 2048 bits, or no exponent.");
            }
            return checked(cose, RS256);
        }
        throw new IllegalArgumentException("Only ES256 (P-256) and RS256 passkeys are taken.");
    }

    /** The key's SPKI once the JCA built it and it fits the algorithm (an EC point on the curve included). */
    private static Spki checked(COSEKey cose, int algorithm) {
        PublicKey built;
        try {
            built = cose.getPublicKey();
        } catch (RuntimeException e) {
            throw new IllegalArgumentException("The key could not be built.", e);
        }
        byte[] spki = built == null ? null : built.getEncoded();
        PublicKey read = publicKey(spki);
        if (read == null || !fits(read, algorithm)) {
            throw new IllegalArgumentException("The key is not one this site takes.");
        }
        return new Spki(spki, algorithm);
    }

    /**
     * The COSE key a stored SPKI and algorithm stand for, for webauthn4j to verify an assertion with; null when the SPKI
     * is no key of the algorithm's kind ({@link #fits}).
     */
    public static COSEKey toCose(byte[] spki, int algorithm) {
        PublicKey key = publicKey(spki);
        if (key == null || !fits(key, algorithm)) {
            return null;
        }
        if (algorithm == ES256 && key instanceof ECPublicKey ec) {
            return EC2COSEKey.create(ec, COSEAlgorithmIdentifier.ES256);
        }
        if (algorithm == RS256 && key instanceof RSAPublicKey rsa) {
            return RSACOSEKey.create(rsa, COSEAlgorithmIdentifier.RS256);
        }
        return null;
    }

    private static boolean isAlgorithm(COSEAlgorithmIdentifier alg, int expected) {
        return alg != null && alg.getValue() == expected;
    }

    /**
     * The public key an SPKI holds, or null when it is not one. A key reader that refuses an EC point that is not on
     * its curve is what a verifier needs (an off-curve point is the invalid-curve attack); the JCA does not refuse one
     * when it reads the key, so that check is made here.
     */
    public static PublicKey publicKey(byte[] spki) {
        if (spki == null || spki.length == 0) {
            return null;
        }
        for (String kind : new String[] {"EC", "RSA"}) {
            try {
                PublicKey key = KeyFactory.getInstance(kind).generatePublic(new X509EncodedKeySpec(spki));
                if (key instanceof ECPublicKey ec && !onCurve(ec)) {
                    return null;
                }
                return key;
            } catch (GeneralSecurityException | RuntimeException e) {
                // Not this kind of key; try the next.
            }
        }
        return null;
    }

    /** Whether an SPKI is a key at all (the registration's publicKey check). */
    public static boolean readable(byte[] spki) {
        return publicKey(spki) != null;
    }

    /** Whether a key fits a COSE algorithm: an EC key on P-256 for ES256, an RSA key of 2048 bits or more for RS256. */
    public static boolean fits(PublicKey key, int algorithm) {
        return switch (algorithm) {
            case ES256 -> key instanceof ECPublicKey ec && isP256(ec.getParams());
            case RS256 -> key instanceof RSAPublicKey rsa && rsa.getModulus().bitLength() >= 2048;
            default -> false;
        };
    }

    static boolean isP256(ECParameterSpec params) {
        return params != null
            && params.getCurve().equals(P256.getCurve())
            && params.getGenerator().equals(P256.getGenerator())
            && params.getOrder().equals(P256.getOrder())
            && params.getCofactor() == P256.getCofactor();
    }

    private static boolean onCurve(ECPublicKey key) {
        ECParameterSpec params = key.getParams();
        if (!(params.getCurve().getField() instanceof ECFieldFp field)) {
            return false;
        }
        BigInteger p = field.getP();
        ECPoint w = key.getW();
        if (w.equals(ECPoint.POINT_INFINITY)) {
            return false;
        }
        BigInteger x = w.getAffineX();
        BigInteger y = w.getAffineY();
        if (x.signum() < 0 || x.compareTo(p) >= 0 || y.signum() < 0 || y.compareTo(p) >= 0) {
            return false;
        }
        BigInteger left = y.multiply(y).mod(p);
        BigInteger right = x.pow(3).add(params.getCurve().getA().multiply(x)).add(params.getCurve().getB()).mod(p);
        return left.equals(right);
    }

    private static ECParameterSpec p256() {
        try {
            AlgorithmParameters parameters = AlgorithmParameters.getInstance("EC");
            parameters.init(new ECGenParameterSpec("secp256r1"));
            return parameters.getParameterSpec(ECParameterSpec.class);
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("The JCA has no P-256 (secp256r1)", e);
        }
    }

}
