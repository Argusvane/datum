package com.argusvane.datum.timestamp;

import java.io.ByteArrayInputStream;
import java.math.BigInteger;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.PrivateKey;
import java.security.Signature;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.security.spec.ECGenParameterSpec;
import java.time.Instant;
import java.util.Date;
import java.util.HexFormat;
import java.util.List;
import org.bouncycastle.asn1.ASN1ObjectIdentifier;
import org.bouncycastle.asn1.DERUTF8String;
import org.bouncycastle.asn1.x500.AttributeTypeAndValue;
import org.bouncycastle.asn1.x500.X500Name;
import org.bouncycastle.asn1.x500.X500NameBuilder;
import org.bouncycastle.asn1.x500.style.BCStyle;
import org.bouncycastle.asn1.x509.BasicConstraints;
import org.bouncycastle.asn1.x509.ExtendedKeyUsage;
import org.bouncycastle.asn1.x509.Extension;
import org.bouncycastle.asn1.x509.KeyPurposeId;
import org.bouncycastle.asn1.x509.KeyUsage;
import org.bouncycastle.cert.X509CertificateHolder;
import org.bouncycastle.cert.jcajce.JcaX509v3CertificateBuilder;
import org.bouncycastle.operator.jcajce.JcaContentSignerBuilder;

/**
 * Certificates made in the tests, where the committed openssl fixtures cannot show a case: a three-certificate RSA
 * chain (root, intermediate, timestamp leaf), and two timestamp certificates that are valid BER but not strict DER
 * (an extension's critical BOOLEAN written 01 rather than FF; a multi-valued RDN whose SET is not sorted), each
 * re-signed over its altered TBSCertificate so its own signature holds.
 */
final class TestCertificates {

    static final Instant NOT_BEFORE = Instant.parse("2020-01-01T00:00:00Z");
    static final Instant NOT_AFTER = Instant.parse("2100-01-01T00:00:00Z");

    private TestCertificates() {
    }

    /** A chain: the timestamp key (leaf, intermediate, root as {@link TsaKey#chain()}), and the root and intermediate apart. */
    record Chain(TsaKey key, X509Certificate root, X509Certificate intermediate) {
    }

    static Chain rsaChain() throws Exception {
        KeyPair rootKeys = rsa();
        KeyPair intermediateKeys = rsa();
        KeyPair leafKeys = rsa();
        X500Name rootName = new X500Name("CN=Datum test root,O=Datum tests");
        X500Name intermediateName = new X500Name("CN=Datum test intermediate,O=Datum tests");
        X500Name leafName = new X500Name("CN=Datum test chained TSA,O=Datum tests");
        X509Certificate root = ca(rootName, rootName, rootKeys.getPublic(), rootKeys.getPrivate(), 1);
        X509Certificate intermediate = ca(intermediateName, rootName, intermediateKeys.getPublic(), rootKeys.getPrivate(), 2);
        JcaX509v3CertificateBuilder leaf = builder(intermediateName, leafName, leafKeys.getPublic(), 3);
        leaf.addExtension(Extension.basicConstraints, true, new BasicConstraints(false));
        leaf.addExtension(Extension.extendedKeyUsage, true, new ExtendedKeyUsage(KeyPurposeId.id_kp_timeStamping));
        X509Certificate leafCertificate = x509(leaf.build(new JcaContentSignerBuilder("SHA256withRSA").build(intermediateKeys.getPrivate())).getEncoded());
        // Handed over in no particular order; the chain is rebuilt leaf first.
        TsaKey key = new TsaKey(leafKeys.getPrivate(), KeyChecks.chain(leafKeys.getPrivate(), List.of(root, leafCertificate, intermediate)));
        return new Chain(key, root, intermediate);
    }

    /**
     * A self-signed EC P-256 timestamp certificate whose critical extended key usage BOOLEAN is written {@code 01 01 01}
     * (BER; DER wants {@code 01 01 FF}). The JDK and openssl read it; a DER re-encoding changes its bytes.
     */
    static TsaKey berBoolean() throws Exception {
        KeyPair keys = ec();
        X500Name name = new X500Name("CN=Datum BER TSA,O=Datum tests");
        JcaX509v3CertificateBuilder builder = builder(name, name, keys.getPublic(), 10);
        builder.addExtension(Extension.extendedKeyUsage, true, new ExtendedKeyUsage(KeyPurposeId.id_kp_timeStamping));
        byte[] tbs = builder.build(new JcaContentSignerBuilder("SHA256withECDSA").build(keys.getPrivate())).toASN1Structure()
            .getTBSCertificate().getEncoded("DER");
        String hex = HexFormat.of().formatHex(tbs);
        int at = unique(hex, "0101ff");
        byte[] altered = HexFormat.of().parseHex(hex.substring(0, at) + "010101" + hex.substring(at + 6));
        return new TsaKey(keys.getPrivate(), List.of(resign(altered, keys.getPrivate())));
    }

    /**
     * A self-signed EC P-256 timestamp certificate whose name is one multi-valued RDN (O + CN) with its SET not in
     * DER order, in both issuer and subject. Bouncy Castle would sort it when it writes the name as DER.
     */
    static TsaKey unsortedRdn() throws Exception {
        KeyPair keys = ec();
        ASN1ObjectIdentifier[] types = {BCStyle.O, BCStyle.CN};
        String[] values = {"Datum tests", "Datum unsorted TSA"};
        X500Name name = new X500NameBuilder(BCStyle.INSTANCE).addMultiValuedRDN(types, values).build();
        JcaX509v3CertificateBuilder builder = builder(name, name, keys.getPublic(), 11);
        builder.addExtension(Extension.extendedKeyUsage, true, new ExtendedKeyUsage(KeyPurposeId.id_kp_timeStamping));
        byte[] tbs = builder.build(new JcaContentSignerBuilder("SHA256withECDSA").build(keys.getPrivate())).toASN1Structure()
            .getTBSCertificate().getEncoded("DER");
        String o = HexFormat.of().formatHex(new AttributeTypeAndValue(BCStyle.O, new DERUTF8String(values[0])).getEncoded("DER"));
        String cn = HexFormat.of().formatHex(new AttributeTypeAndValue(BCStyle.CN, new DERUTF8String(values[1])).getEncoded("DER"));
        String hex = HexFormat.of().formatHex(tbs);
        String sorted = hex.contains(o + cn) ? o + cn : cn + o;
        String swapped = sorted.equals(o + cn) ? cn + o : o + cn;
        if (hex.split(sorted, -1).length != 3) {
            throw new IllegalStateException("expected the RDN SET twice (issuer and subject)");
        }
        return new TsaKey(keys.getPrivate(), List.of(resign(HexFormat.of().parseHex(hex.replace(sorted, swapped)), keys.getPrivate())));
    }

    private static int unique(String hex, String pattern) {
        int at = hex.indexOf(pattern);
        if (at < 0 || hex.indexOf(pattern, at + 1) >= 0) {
            throw new IllegalStateException(pattern + " is not unique in the TBSCertificate");
        }
        return at;
    }

    /** A Certificate over a TBSCertificate as given, signed with ECDSA P-256 / SHA-256. */
    private static X509Certificate resign(byte[] tbs, PrivateKey key) throws Exception {
        Signature signer = Signature.getInstance("SHA256withECDSA");
        signer.initSign(key);
        signer.update(tbs);
        byte[] signature = signer.sign();
        byte[] bits = new byte[signature.length + 1];
        System.arraycopy(signature, 0, bits, 1, signature.length);
        return x509(Der.sequence(tbs, Der.sequence(Der.oid("1.2.840.10045.4.3.2")), Der.tlv(0x03, bits)));
    }

    private static X509Certificate ca(X500Name subject, X500Name issuer, java.security.PublicKey publicKey, PrivateKey signer, long serial)
        throws Exception {
        JcaX509v3CertificateBuilder builder = builder(issuer, subject, publicKey, serial);
        builder.addExtension(Extension.basicConstraints, true, new BasicConstraints(true));
        builder.addExtension(Extension.keyUsage, true, new KeyUsage(KeyUsage.keyCertSign | KeyUsage.cRLSign));
        X509CertificateHolder holder = builder.build(new JcaContentSignerBuilder("SHA256withRSA").build(signer));
        return x509(holder.getEncoded());
    }

    private static JcaX509v3CertificateBuilder builder(X500Name issuer, X500Name subject, java.security.PublicKey publicKey, long serial) {
        return new JcaX509v3CertificateBuilder(issuer, BigInteger.valueOf(serial), Date.from(NOT_BEFORE), Date.from(NOT_AFTER), subject, publicKey);
    }

    static X509Certificate x509(byte[] der) throws Exception {
        return (X509Certificate) CertificateFactory.getInstance("X.509").generateCertificate(new ByteArrayInputStream(der));
    }

    private static KeyPair rsa() throws Exception {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA");
        generator.initialize(2048);
        return generator.generateKeyPair();
    }

    private static KeyPair ec() throws Exception {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
        generator.initialize(new ECGenParameterSpec("secp256r1"));
        return generator.generateKeyPair();
    }
}
