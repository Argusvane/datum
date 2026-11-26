package com.argusvane.datum.timestamp;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.math.BigInteger;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.bouncycastle.asn1.ASN1Boolean;
import org.bouncycastle.asn1.ASN1Encoding;
import org.bouncycastle.asn1.ASN1Integer;
import org.bouncycastle.asn1.ASN1ObjectIdentifier;
import org.bouncycastle.asn1.DERNull;
import org.bouncycastle.asn1.tsp.MessageImprint;
import org.bouncycastle.asn1.tsp.TimeStampReq;
import org.bouncycastle.asn1.x509.AlgorithmIdentifier;

/**
 * An RFC 3161 TimeStampReq, read; and the requests a client writes.
 *
 * <pre>
 * TimeStampReq ::= SEQUENCE {
 *   version         INTEGER { v1(1) },
 *   messageImprint  MessageImprint,
 *   reqPolicy       TSAPolicyId OPTIONAL,
 *   nonce           INTEGER OPTIONAL,
 *   certReq         BOOLEAN DEFAULT FALSE,
 *   extensions      [0] IMPLICIT Extensions OPTIONAL }
 * </pre>
 *
 * <p>Imprints over SHA-256, SHA-384 and SHA-512 are taken; SHA-1 and anything else are refused (badAlg), as are
 * imprints of the wrong length, any other version or malformed bytes (badDataFormat) and any extension
 * (unacceptedExtension: the server knows none). The checks run in a fixed order, so the same request gets the
 * same refusal, word for word, on every host (the statusString the host kit's TSA cases read; the words are on the wire): the structure and extensions first, the algorithm after,
 * the length last.
 *
 * <p>Read with Datum's own DER reader ({@link Der}), not Bouncy Castle's {@code TimeStampRequest}: the refusal
 * reasons and the object-identifier caps are the wire's, and Bouncy Castle refuses or accepts other inputs with other
 * words. The requests a client writes ({@link #forDigest}) are
 * written with Bouncy Castle's ASN.1 types.
 */
public final class TimestampQuery {

    /** SHA-256, as an imprint algorithm. */
    public static final String SHA256 = "sha256";
    /** SHA-384, as an imprint algorithm. */
    public static final String SHA384 = "sha384";
    /** SHA-512, as an imprint algorithm. */
    public static final String SHA512 = "sha512";

    private record Known(String name, int length, String jcaName) {
    }

    /** The imprint algorithms taken: OID to name and digest length. */
    private static final Map<String, Known> ALGORITHMS = Map.of(
        "2.16.840.1.101.3.4.2.1", new Known(SHA256, 32, "SHA-256"),
        "2.16.840.1.101.3.4.2.2", new Known(SHA384, 48, "SHA-384"),
        "2.16.840.1.101.3.4.2.3", new Known(SHA512, 64, "SHA-512"));

    /** SHA-1, named when it is refused. */
    private static final String SHA1 = "1.3.14.3.2.26";

    private final String algorithm;
    private final String algorithmOid;
    private final byte[] hash;
    private final byte[] messageImprint;
    private final String policy;
    private final byte[] nonce;
    private final boolean certReq;

    private TimestampQuery(String algorithm, String algorithmOid, byte[] hash, byte[] messageImprint, String policy, byte[] nonce,
        boolean certReq) {
        this.algorithm = algorithm;
        this.algorithmOid = algorithmOid;
        this.hash = hash;
        this.messageImprint = messageImprint;
        this.policy = policy;
        this.nonce = nonce;
        this.certReq = certReq;
    }

    /** The imprint's algorithm: {@code sha256}, {@code sha384} or {@code sha512}. */
    public String algorithm() {
        return algorithm;
    }

    /** The imprint algorithm's object identifier, dotted. */
    public String algorithmOid() {
        return algorithmOid;
    }

    /** The hashed message, raw bytes. */
    public byte[] hash() {
        return hash.clone();
    }

    /** The MessageImprint as it came (DER), which the token repeats. */
    public byte[] messageImprint() {
        return messageImprint.clone();
    }

    /** The policy asked for, dotted, or {@code null}. */
    public String policy() {
        return policy;
    }

    /** The nonce INTEGER as it came (DER, tag and length included), which the token echoes; {@code null} for none. */
    public byte[] nonce() {
        return nonce == null ? null : nonce.clone();
    }

    /** Whether the server's certificate is asked for in the token. */
    public boolean certReq() {
        return certReq;
    }

    /**
     * Reads a TimeStampReq.
     *
     * @throws TimestampRefusedException when it cannot be read or asks for what the server does not do
     */
    public static TimestampQuery parse(byte[] der) {
        String oid;
        byte[] hash;
        Der.Node imprintNode;
        String policy = null;
        byte[] nonce = null;
        boolean certReq = false;
        try {
            Der.Node root = Der.readAll(der);
            if (root.tag() != Der.SEQUENCE) {
                throw new IllegalArgumentException("not a SEQUENCE");
            }
            List<Der.Node> fields = Der.children(der, root);
            if (fields.size() < 2 || Der.readSmallInteger(der, fields.get(0)) != 1) {
                throw new TimestampRefusedException(TimestampRefusal.FAIL_BAD_DATA_FORMAT, "Only version 1 timestamp requests are read.");
            }
            imprintNode = fields.get(1);
            if (imprintNode.tag() != Der.SEQUENCE) {
                throw new IllegalArgumentException("no MessageImprint");
            }
            List<Der.Node> imprint = Der.children(der, imprintNode);
            if (imprint.size() != 2 || imprint.get(0).tag() != Der.SEQUENCE || imprint.get(1).tag() != Der.OCTET_STRING) {
                throw new IllegalArgumentException("a malformed MessageImprint");
            }
            List<Der.Node> algorithm = Der.children(der, imprint.get(0));
            if (algorithm.isEmpty() || algorithm.size() > 2
                || (algorithm.size() == 2 && !java.util.Arrays.equals(Der.raw(der, algorithm.get(1)), Der.nul()))) {
                throw new IllegalArgumentException("a malformed hash AlgorithmIdentifier");
            }
            oid = Der.readOid(der, algorithm.get(0));
            hash = Der.contents(der, imprint.get(1));
            int order = 0;
            for (Der.Node field : fields.subList(2, fields.size())) {
                // The optional fields come in their order, each at most once.
                int rank = switch (field.tag()) {
                    case Der.OID -> 1;
                    case Der.INTEGER -> 2;
                    case Der.BOOLEAN -> 3;
                    case 0xa0 -> 4;
                    default -> throw new IllegalArgumentException("an unknown field");
                };
                if (rank <= order) {
                    throw new IllegalArgumentException("fields out of order");
                }
                order = rank;
                if (rank == 1) {
                    policy = Der.readOid(der, field);
                } else if (rank == 2) {
                    nonce = nonce(der, field);
                } else if (rank == 3) {
                    certReq = Der.readBoolean(der, field);
                } else {
                    throw new TimestampRefusedException(TimestampRefusal.FAIL_UNACCEPTED_EXTENSION,
                        "This timestamp server accepts no request extensions.");
                }
            }
        } catch (IllegalArgumentException e) {
            // The wire's words, the reader's own full stop included.
            throw new TimestampRefusedException(TimestampRefusal.FAIL_BAD_DATA_FORMAT,
                "The request is not a TimeStampReq: " + e.getMessage() + ".");
        }
        Known known = ALGORITHMS.get(oid);
        if (known == null) {
            throw new TimestampRefusedException(TimestampRefusal.FAIL_BAD_ALG, SHA1.equals(oid)
                ? "SHA-1 imprints are refused: use SHA-256, SHA-384 or SHA-512."
                : "The imprint algorithm " + oid + " is not taken: use SHA-256, SHA-384 or SHA-512.");
        }
        if (hash.length != known.length()) {
            throw new TimestampRefusedException(TimestampRefusal.FAIL_BAD_DATA_FORMAT,
                String.format(Locale.ROOT, "A %s imprint is %d bytes; this one is %d.", known.name().toUpperCase(Locale.ROOT), known.length(),
                    hash.length));
        }
        return new TimestampQuery(known.name(), oid, hash, Der.raw(der, imprintNode), policy, nonce, certReq);
    }

    /** A TimeStampReq over data with a SHA-256 imprint, the certificate asked for, no nonce and no policy. */
    public static byte[] forData(byte[] data) {
        return forData(data, SHA256, true, null, null);
    }

    /**
     * Writes a TimeStampReq over data, as the module asks its own server.
     *
     * @param data the bytes to timestamp (a signature value, a stored document)
     * @param algorithm the digest: {@code sha256}, {@code sha384} or {@code sha512}
     * @param certReq whether to ask for the server's certificate in the token
     * @param nonce raw bytes of a nonce (positive), or {@code null} for none
     * @param policy a policy to ask for, or {@code null}
     */
    public static byte[] forData(byte[] data, String algorithm, boolean certReq, byte[] nonce, String policy) {
        return forDigest(algorithm, digest(algorithm, data), certReq, nonce, policy);
    }

    /** A TimeStampReq over a digest already made, the certificate asked for, no nonce and no policy. */
    public static byte[] forDigest(String algorithm, byte[] digest) {
        return forDigest(algorithm, digest, true, null, null);
    }

    /**
     * Writes a TimeStampReq over a digest already made: {@code SEQ{INTEGER 1, SEQ{SEQ{oid, NULL}, OCTET digest},
     * [policy], [nonce], [BOOLEAN TRUE]}}, the NULL parameters kept as openssl and the PDF kernel write them.
     *
     * @param algorithm the digest: {@code sha256}, {@code sha384} or {@code sha512}
     * @param digest the raw digest (its length is not checked here; the server checks it)
     * @param certReq whether to ask for the server's certificate in the token
     * @param nonce raw bytes of a nonce (positive, big-endian), or {@code null} for none
     * @param policy a policy to ask for, dotted, or {@code null}
     * @throws IllegalArgumentException for an algorithm not taken or a policy that is not an object identifier
     */
    public static byte[] forDigest(String algorithm, byte[] digest, boolean certReq, byte[] nonce, String policy) {
        String oid = oidOf(algorithm);
        if (policy != null && !Der.validOid(policy)) {
            throw new IllegalArgumentException(String.format("DER: %s is not an object identifier.", policy));
        }
        MessageImprint imprint = new MessageImprint(new AlgorithmIdentifier(new ASN1ObjectIdentifier(oid), DERNull.INSTANCE), digest);
        TimeStampReq request = new TimeStampReq(imprint,
            policy == null ? null : new ASN1ObjectIdentifier(policy),
            nonce == null ? null : new ASN1Integer(new BigInteger(1, nonce)),
            certReq ? ASN1Boolean.TRUE : null,
            null);
        try {
            return request.getEncoded(ASN1Encoding.DER);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    /** The digest of data under an imprint algorithm's name. */
    static byte[] digest(String algorithm, byte[] data) {
        String oid = oidOf(algorithm);
        try {
            return MessageDigest.getInstance(ALGORITHMS.get(oid).jcaName()).digest(data);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-2 is required of every Java platform", e);
        }
    }

    /** The JCA name of an imprint algorithm ({@code sha256} to {@code SHA-256}), or {@code null} for one not taken. */
    static String jcaName(String algorithm) {
        for (Known known : ALGORITHMS.values()) {
            if (known.name().equals(algorithm)) {
                return known.jcaName();
            }
        }
        return null;
    }

    private static String oidOf(String algorithm) {
        for (Map.Entry<String, Known> entry : ALGORITHMS.entrySet()) {
            if (entry.getValue().name().equals(algorithm)) {
                return entry.getKey();
            }
        }
        throw new IllegalArgumentException(String.format("No timestamp imprint over %s.", algorithm));
    }

    /** A nonce, as it came: a positive INTEGER of at most 64 bytes. */
    private static byte[] nonce(byte[] der, Der.Node node) {
        byte[] bytes = Der.contents(der, node);
        if (bytes.length == 0 || bytes.length > 64 || (bytes[0] & 0xff) >= 0x80) {
            throw new IllegalArgumentException("a nonce that is not a positive integer of at most 64 bytes");
        }
        return Der.raw(der, node);
    }
}
