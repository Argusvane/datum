package com.argusvane.datum.timestamp;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.PublicKey;
import java.security.Signature;
import java.security.cert.CertificateEncodingException;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * An RFC 3161 TimeStampToken, read: what it vouches for, when, and by whom; like the PDF kernel's
 * {@code parseTimestampToken}, it takes a whole TimeStampResp too.
 *
 * <pre>
 * TimeStampToken ::= ContentInfo { id-signedData, SignedData {
 *   version, digestAlgorithms,
 *   encapContentInfo { id-ct-TSTInfo, [0] OCTET STRING TSTInfo },
 *   certificates [0] IMPLICIT OPTIONAL, crls [1] IMPLICIT OPTIONAL,
 *   signerInfos SET OF SignerInfo } }
 * TSTInfo ::= SEQUENCE { version, policy, messageImprint, serialNumber,
 *   genTime, accuracy OPTIONAL, ordering DEFAULT FALSE, nonce OPTIONAL,
 *   tsa [0] GeneralName OPTIONAL, extensions [1] OPTIONAL }
 * </pre>
 *
 * <p>Reads the imprint (algorithm and hash), the serial number, genTime, the policy, the certificates the token
 * carries and its first SignerInfo. {@link #check} says whether the token vouches for given bytes and whether its
 * signature holds: the messageDigest attribute is the digest of the TSTInfo, and the signed attributes, taken as
 * the bytes they are, verify with a certificate's key (RSA PKCS#1 v1.5, ECDSA or DSA, as openssl_verify does).
 * {@link #verifyOver} checks the token as a whole, as verifying a PDF relies on it: also its content type, that
 * its signingCertificate(V2) attribute names the certificate that signed it, and genTime within that
 * certificate's validity. Whether that certificate is to be trusted is not judged here: the caller decides by
 * fingerprint or trust anchor, as {@code openssl ts -verify} does with a trust anchor.
 *
 * <p>Read with the module's DER reader, not Bouncy Castle's {@code TimeStampToken}: Bouncy Castle refuses at
 * construction a token without a signingCertificate attribute or with more than one signer (this reader reads it and
 * reports {@code binding} or checks the first signer, as the kernel does), and re-encodes signed attributes it parsed
 * (a TSA that did not sort them as DER asks would no longer verify). The signed attributes are verified as the
 * bytes they are, re-tagged as a SET.
 */
public final class TimestampToken {

    private static final String OID_SIGNED_DATA = "1.2.840.113549.1.7.2";
    private static final String OID_TST_INFO = "1.2.840.113549.1.9.16.1.4";
    private static final String OID_MESSAGE_DIGEST = "1.2.840.113549.1.9.4";
    private static final String OID_CONTENT_TYPE = "1.2.840.113549.1.9.3";
    private static final String OID_SIGNING_CERTIFICATE = "1.2.840.113549.1.9.16.2.12";
    private static final String OID_SIGNING_CERTIFICATE_V2 = "1.2.840.113549.1.9.16.2.47";

    private record Digest(String name, String jca, String signature) {
    }

    /** Digest algorithms by OID: the name, the JCA digest and the JCA signature prefix. */
    private static final Map<String, Digest> DIGESTS = Map.of(
        "2.16.840.1.101.3.4.2.1", new Digest("sha256", "SHA-256", "SHA256"),
        "2.16.840.1.101.3.4.2.2", new Digest("sha384", "SHA-384", "SHA384"),
        "2.16.840.1.101.3.4.2.3", new Digest("sha512", "SHA-512", "SHA512"),
        "1.3.14.3.2.26", new Digest("sha1", "SHA-1", "SHA1"));

    private static final Pattern GENERALIZED_TIME = Pattern.compile("^(\\d{4})(\\d{2})(\\d{2})(\\d{2})(\\d{2})(\\d{2})(?:\\.(\\d+))?Z$");

    /** What does not hold of a token, as {@link #verifyOver} reports it. */
    public enum Problem {
        /** The imprint is not the data's digest. */
        IMPRINT,
        /** No certificate at hand verifies the signature, or it is signed in a way not checked here. */
        SIGNATURE,
        /** The signingCertificate(V2) attribute does not name the certificate that signed it. */
        BINDING,
        /** genTime falls outside the signing certificate's validity. */
        TIME;

        /** The verify report's code: {@code imprint}, {@code signature}, {@code binding} or {@code time}. */
        public String code() {
            return name().toLowerCase(java.util.Locale.ROOT);
        }
    }

    /**
     * The token checked against the bytes it should vouch for.
     *
     * @param covers whether the imprint is theirs
     * @param signature whether the signature holds; {@code null} when no certificate at hand is the signer's
     *     candidate, or the token is signed in a way not checked here
     * @param signer the signer's certificate, or {@code null}
     */
    public record Check(boolean covers, Boolean signature, X509Certificate signer) {
    }

    /**
     * The token checked as a whole.
     *
     * @param covers whether the imprint is the data's
     * @param signer the certificate that signed it, when the signature holds
     * @param problem what does not hold, or {@code null} when everything holds
     */
    public record Verification(boolean covers, X509Certificate signer, Problem problem) {
    }

    private record EssCertificate(String algorithm, byte[] hash) {
    }

    private final byte[] der;
    private final String algorithm;
    private final byte[] hash;
    private final String serial;
    private final long genTime;
    private final String genTimeText;
    private final String policy;
    private final List<X509Certificate> certificates;
    private final int carried;
    private final byte[] tstInfo;
    private final byte[] signedAttributes;
    private final byte[] messageDigest;
    private final String signerDigest;
    private final byte[] signature;
    private final String contentType;
    private final EssCertificate essCertificate;
    private final byte[] nonce;

    private TimestampToken(byte[] der, String algorithm, byte[] hash, String serial, long genTime, String genTimeText, String policy,
        List<X509Certificate> certificates, int carried, byte[] tstInfo, byte[] signedAttributes, byte[] messageDigest, String signerDigest,
        byte[] signature, String contentType, EssCertificate essCertificate, byte[] nonce) {
        this.der = der;
        this.algorithm = algorithm;
        this.hash = hash;
        this.serial = serial;
        this.genTime = genTime;
        this.genTimeText = genTimeText;
        this.policy = policy;
        this.certificates = certificates;
        this.carried = carried;
        this.tstInfo = tstInfo;
        this.signedAttributes = signedAttributes;
        this.messageDigest = messageDigest;
        this.signerDigest = signerDigest;
        this.signature = signature;
        this.contentType = contentType;
        this.essCertificate = essCertificate;
        this.nonce = nonce;
    }

    /**
     * Reads the token out of a granted TimeStampResp.
     *
     * @throws IllegalArgumentException when the reply is not granted or holds no readable token
     */
    public static TimestampToken fromResponse(byte[] response) {
        if (!TimestampClient.granted(response)) {
            throw new IllegalArgumentException("The reply does not grant a timestamp.");
        }
        Der.Node root = Der.readAll(response);
        List<Der.Node> parts = Der.children(response, root);
        if (parts.size() < 2) {
            throw new IllegalArgumentException("The reply carries no token.");
        }
        return parseToken(Der.raw(response, parts.get(1)));
    }

    /**
     * Reads a TimeStampToken, or the token out of a whole TimeStampResp (told apart as the PDF kernel tells them
     * apart: a reply's first field is its PKIStatusInfo SEQUENCE, a token's is its content type).
     *
     * @throws IllegalArgumentException when it is neither, or a reply that grants nothing
     */
    public static TimestampToken parse(byte[] der) {
        Der.Node root = Der.readAll(der);
        List<Der.Node> top = root.tag() == Der.SEQUENCE ? Der.children(der, root) : List.of();
        if (!top.isEmpty() && top.get(0).tag() == Der.SEQUENCE) {
            return fromResponse(der);
        }
        return parseToken(der);
    }

    /**
     * Reads a bare TimeStampToken (a CMS ContentInfo).
     *
     * @throws IllegalArgumentException when it is not one
     */
    public static TimestampToken parseToken(byte[] der) {
        der = der.clone();
        Der.Node root = Der.readAll(der);
        List<Der.Node> contentInfo = Der.children(der, root);
        if (contentInfo.size() != 2 || !Der.readOid(der, contentInfo.get(0)).equals(OID_SIGNED_DATA) || contentInfo.get(1).tag() != 0xa0) {
            throw new IllegalArgumentException("Not a CMS SignedData.");
        }
        List<Der.Node> wrapped = Der.children(der, contentInfo.get(1));
        Der.Node signedData = wrapped.isEmpty() ? null : wrapped.get(0);
        if (signedData == null || signedData.tag() != Der.SEQUENCE) {
            throw new IllegalArgumentException("Not a CMS SignedData.");
        }
        List<Der.Node> fields = Der.children(der, signedData);
        if (fields.size() < 4) {
            throw new IllegalArgumentException("A SignedData cut short.");
        }
        List<Der.Node> encapsulated = Der.children(der, fields.get(2));
        if (encapsulated.size() != 2 || !Der.readOid(der, encapsulated.get(0)).equals(OID_TST_INFO) || encapsulated.get(1).tag() != 0xa0) {
            throw new IllegalArgumentException("The SignedData holds no TSTInfo.");
        }
        List<Der.Node> content = Der.children(der, encapsulated.get(1));
        Der.Node octets = content.isEmpty() ? null : content.get(0);
        if (octets == null || octets.tag() != Der.OCTET_STRING) {
            throw new IllegalArgumentException("The TSTInfo is not an OCTET STRING.");
        }
        byte[] tstInfo = Der.contents(der, octets);
        List<X509Certificate> certificates = new ArrayList<>();
        int carried = 0;
        Der.Node signerInfos = null;
        for (Der.Node field : fields.subList(3, fields.size())) {
            if (field.tag() == 0xa0) {
                for (Der.Node certificate : Der.children(der, field)) {
                    if (certificate.tag() == Der.SEQUENCE) {
                        carried++;
                        X509Certificate read = certificate(Der.raw(der, certificate));
                        if (read != null) {
                            certificates.add(read);
                        }
                    }
                }
            } else if (field.tag() == Der.SET) {
                signerInfos = field;
            }
        }
        List<Der.Node> signers = signerInfos == null ? List.of() : Der.children(der, signerInfos);
        if (signers.isEmpty()) {
            throw new IllegalArgumentException("The SignedData has no signer.");
        }
        List<Der.Node> signer = Der.children(der, signers.get(0));
        if (signer.size() < 5) {
            throw new IllegalArgumentException("A SignerInfo cut short.");
        }
        List<Der.Node> digestAlgorithm = Der.children(der, signer.get(2));
        if (digestAlgorithm.isEmpty()) {
            throw new IllegalArgumentException("A SignerInfo cut short.");
        }
        String digestOid = Der.readOid(der, digestAlgorithm.get(0));
        byte[] signedAttributes = null;
        byte[] messageDigest = null;
        String contentType = null;
        EssCertificate essCertificate = null;
        int next = 3;
        if (signer.get(3).tag() == 0xa0) {
            // Signed as a SET OF: the [0] IMPLICIT tag is replaced by SET's.
            signedAttributes = Der.raw(der, signer.get(3));
            signedAttributes[0] = (byte) Der.SET;
            for (Der.Node attribute : Der.children(der, signer.get(3))) {
                List<Der.Node> parts = Der.children(der, attribute);
                if (parts.size() != 2) {
                    continue;
                }
                List<Der.Node> values = Der.children(der, parts.get(1));
                Der.Node value = values.isEmpty() ? null : values.get(0);
                String type = Der.readOid(der, parts.get(0));
                if (type.equals(OID_MESSAGE_DIGEST)) {
                    messageDigest = value != null && value.tag() == Der.OCTET_STRING ? Der.contents(der, value) : null;
                } else if (type.equals(OID_CONTENT_TYPE) && value != null && value.tag() == Der.OID) {
                    contentType = Der.readOid(der, value);
                } else if ((type.equals(OID_SIGNING_CERTIFICATE_V2) || type.equals(OID_SIGNING_CERTIFICATE)) && value != null
                    && essCertificate == null) {
                    essCertificate = essCertId(der, value, type.equals(OID_SIGNING_CERTIFICATE_V2));
                }
            }
            next = 4;
        }
        Der.Node signatureNode = signer.size() > next + 1 ? signer.get(next + 1) : null;
        if (signatureNode == null || signatureNode.tag() != Der.OCTET_STRING) {
            throw new IllegalArgumentException("The SignerInfo has no signature.");
        }

        List<Der.Node> info = Der.children(tstInfo, Der.readAll(tstInfo));
        if (info.size() < 5) {
            throw new IllegalArgumentException("A TSTInfo cut short.");
        }
        List<Der.Node> imprint = Der.children(tstInfo, info.get(2));
        if (imprint.isEmpty()) {
            throw new IllegalArgumentException("No imprint.");
        }
        List<Der.Node> imprintAlgorithm = Der.children(tstInfo, imprint.get(0));
        if (imprintAlgorithm.isEmpty()) {
            throw new IllegalArgumentException("No imprint.");
        }
        String imprintOid = Der.readOid(tstInfo, imprintAlgorithm.get(0));
        if (!DIGESTS.containsKey(imprintOid) || imprint.size() < 2 || imprint.get(1).tag() != Der.OCTET_STRING) {
            throw new IllegalArgumentException("An imprint over a digest this site does not read.");
        }
        if (info.get(3).tag() != Der.INTEGER || info.get(4).tag() != Der.GENERALIZED_TIME) {
            throw new IllegalArgumentException("A TSTInfo without serial number or genTime.");
        }
        String timeText = new String(Der.contents(tstInfo, info.get(4)), StandardCharsets.ISO_8859_1);
        Matcher m = GENERALIZED_TIME.matcher(timeText);
        if (!m.matches()) {
            throw new IllegalArgumentException("A genTime that is not a UTC GeneralizedTime.");
        }
        // As gmmktime() takes the fields: out-of-range values carry over rather than being refused.
        long seconds = LocalDateTime.of(Integer.parseInt(m.group(1)), 1, 1, 0, 0)
            .plusMonths(Long.parseLong(m.group(2)) - 1).plusDays(Long.parseLong(m.group(3)) - 1)
            .plusHours(Long.parseLong(m.group(4))).plusMinutes(Long.parseLong(m.group(5))).plusSeconds(Long.parseLong(m.group(6)))
            .toEpochSecond(ZoneOffset.UTC);
        String iso = String.format("%s-%s-%sT%s:%s:%s%sZ", m.group(1), m.group(2), m.group(3), m.group(4), m.group(5), m.group(6),
            m.group(7) != null ? "." + m.group(7) : "");
        byte[] serialBytes = Der.contents(tstInfo, info.get(3));
        int skip = 0;
        while (skip < serialBytes.length && serialBytes[skip] == 0) {
            skip++;
        }
        String serial = skip == serialBytes.length ? "00" : HexFormat.of().formatHex(serialBytes, skip, serialBytes.length);
        // The nonce, read as the kernel reads it: the first INTEGER after genTime. Nothing rests on it here.
        byte[] nonce = null;
        for (Der.Node field : info.subList(5, info.size())) {
            if (field.tag() == Der.INTEGER) {
                nonce = Der.raw(tstInfo, field);
                break;
            }
        }
        return new TimestampToken(der, DIGESTS.get(imprintOid).name(), Der.contents(tstInfo, imprint.get(1)), serial, seconds, iso,
            Der.readOid(tstInfo, info.get(1)), List.copyOf(certificates), carried, tstInfo, signedAttributes, messageDigest,
            DIGESTS.containsKey(digestOid) ? digestOid : null, Der.contents(der, signatureNode), contentType, essCertificate, nonce);
    }

    /**
     * The first ESSCertID(v2) of a signingCertificate(V2) attribute value: the digest name and the certificate's
     * hash, or {@code null} when unreadable.
     */
    private static EssCertificate essCertId(byte[] der, Der.Node node, boolean v2) {
        List<Der.Node> top = Der.children(der, node);
        Der.Node certs = top.isEmpty() ? null : top.get(0);
        Der.Node first = null;
        if (certs != null && certs.tag() == Der.SEQUENCE) {
            List<Der.Node> list = Der.children(der, certs);
            first = list.isEmpty() ? null : list.get(0);
        }
        if (first == null || first.tag() != Der.SEQUENCE) {
            return null;
        }
        List<Der.Node> parts = new ArrayList<>(Der.children(der, first));
        String algorithm = v2 ? "sha256" : "sha1";
        if (v2 && !parts.isEmpty() && parts.get(0).tag() == Der.SEQUENCE) {
            List<Der.Node> identifier = Der.children(der, parts.get(0));
            if (identifier.isEmpty()) {
                throw new IllegalArgumentException("An empty hash algorithm.");
            }
            String oid = Der.readOid(der, identifier.get(0));
            algorithm = DIGESTS.containsKey(oid) ? DIGESTS.get(oid).name() : "";
            parts.remove(0);
        }
        Der.Node hash = parts.isEmpty() ? null : parts.get(0);
        if (algorithm.isEmpty() || hash == null || hash.tag() != Der.OCTET_STRING) {
            return null;
        }
        return new EssCertificate(algorithm, Der.contents(der, hash));
    }

    private static X509Certificate certificate(byte[] der) {
        try {
            return (X509Certificate) CertificateFactory.getInstance("X.509").generateCertificate(new ByteArrayInputStream(der));
        } catch (GeneralSecurityException | RuntimeException e) {
            return null;
        }
    }

    /** The TSTInfo as signed (the eContent's octets). */
    byte[] tstInfo() {
        return tstInfo.clone();
    }

    /** The TimeStampToken (a ContentInfo), DER. */
    public byte[] der() {
        return der.clone();
    }

    /** The imprint's digest: {@code sha256}, {@code sha384}, {@code sha512} or {@code sha1}. */
    public String algorithm() {
        return algorithm;
    }

    /** The imprint, raw. */
    public byte[] hash() {
        return hash.clone();
    }

    /** The serial number, lowercase hex, leading zero bytes dropped ({@code 00} for zero). */
    public String serial() {
        return serial;
    }

    /** genTime, whole seconds. */
    public Instant genTime() {
        return Instant.ofEpochSecond(genTime);
    }

    /** genTime in ISO 8601 (UTC), fractions as the token states them. */
    public String genTimeText() {
        return genTimeText;
    }

    /** The policy, dotted. */
    public String policy() {
        return policy;
    }

    /** The certificates the token carries that read as X.509 certificates. */
    public List<X509Certificate> certificates() {
        return certificates;
    }

    /** The nonce INTEGER as the token writes it (DER, whole), or {@code null} when it has none. */
    public byte[] nonce() {
        return nonce == null ? null : nonce.clone();
    }

    /** The token wrapped as a granted TimeStampResp, as openssl ts reads it. */
    public byte[] response() {
        return Der.sequence(Der.sequence(Der.integer(0)), der);
    }

    /** Whether the imprint is the digest of these bytes. */
    public boolean covers(byte[] data) {
        return MessageDigest.isEqual(hash, digest(DIGESTS.values().stream().filter(d -> d.name().equals(algorithm)).findFirst().orElseThrow().jca(), data));
    }

    /**
     * The certificate whose key signed the token, among its own certificates and the ones given; {@code null}
     * when none of them did, or the signed attributes do not hold.
     *
     * @param candidates more certificates to try: the host's own timestamp server's
     */
    public X509Certificate signer(List<X509Certificate> candidates) {
        if (signedAttributes == null || signerDigest == null || messageDigest == null) {
            return null;
        }
        Digest digest = DIGESTS.get(signerDigest);
        if (!MessageDigest.isEqual(messageDigest, digest(digest.jca(), tstInfo))) {
            return null;
        }
        List<X509Certificate> all = new ArrayList<>(certificates);
        all.addAll(candidates);
        for (X509Certificate certificate : all) {
            if (verifies(certificate.getPublicKey(), digest)) {
                return certificate;
            }
        }
        return null;
    }

    /**
     * The token checked against the bytes it should vouch for.
     *
     * @param data the bytes
     * @param candidates more certificates its signer may be
     */
    public Check check(byte[] data, List<X509Certificate> candidates) {
        X509Certificate signer = signer(candidates);
        boolean checkable = signedAttributes != null && signerDigest != null && messageDigest != null && (carried > 0 || !candidates.isEmpty());
        return new Check(covers(data), signer != null ? Boolean.TRUE : (checkable ? Boolean.FALSE : null), signer);
    }

    /**
     * The token checked as a whole, as verifying a PDF relies on it: its imprint is the digest of the data; it is
     * a CMS SignedData over a TSTInfo (the contentType attribute says so); its messageDigest is the TSTInfo's
     * digest; the signed attributes verify with a certificate's key, among those it carries and the candidates;
     * its signingCertificate(V2) names that certificate (RFC 3161 section 2.4.1 requires one); and genTime falls
     * within that certificate's validity. Who the signer is, and whether to trust it, is for the caller.
     *
     * @param data the bytes the token should vouch for (a signature value)
     * @param candidates more certificates its signer may be
     */
    public Verification verifyOver(byte[] data, List<X509Certificate> candidates) {
        boolean covers = covers(data);
        X509Certificate signer = OID_TST_INFO.equals(contentType) ? signer(candidates) : null;
        Problem problem;
        if (!covers) {
            problem = Problem.IMPRINT;
        } else if (signer == null) {
            problem = Problem.SIGNATURE;
        } else if (!names(signer)) {
            problem = Problem.BINDING;
        } else if (!validAt(signer, genTime)) {
            problem = Problem.TIME;
        } else {
            problem = null;
        }
        return new Verification(covers, signer, problem);
    }

    /** Whether the token's signingCertificate(V2) attribute names a certificate. */
    public boolean names(X509Certificate certificate) {
        if (essCertificate == null) {
            return false;
        }
        String jca = DIGESTS.values().stream().filter(d -> d.name().equals(essCertificate.algorithm())).findFirst().orElseThrow().jca();
        try {
            return MessageDigest.isEqual(essCertificate.hash(), digest(jca, certificate.getEncoded()));
        } catch (CertificateEncodingException e) {
            return false;
        }
    }

    private boolean verifies(PublicKey key, Digest digest) {
        String kind = switch (key.getAlgorithm()) {
            case "RSA" -> "RSA";
            case "EC", "ECDSA" -> "ECDSA";
            case "DSA" -> "DSA";
            default -> null;
        };
        if (kind == null) {
            return false;
        }
        try {
            Signature verifier = Signature.getInstance(digest.signature() + "with" + kind);
            verifier.initVerify(key);
            verifier.update(signedAttributes);
            return verifier.verify(signature);
        } catch (GeneralSecurityException | RuntimeException e) {
            return false;
        }
    }

    private static boolean validAt(X509Certificate certificate, long seconds) {
        return seconds >= certificate.getNotBefore().toInstant().getEpochSecond() && seconds <= certificate.getNotAfter().toInstant().getEpochSecond();
    }

    private static byte[] digest(String algorithm, byte[] data) {
        try {
            return MessageDigest.getInstance(algorithm).digest(data);
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(algorithm + " is required of every Java platform", e);
        }
    }
}
