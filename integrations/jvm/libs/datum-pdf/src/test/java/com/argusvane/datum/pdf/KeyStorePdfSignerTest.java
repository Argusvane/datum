package com.argusvane.datum.pdf;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.timestamp.TsaKey;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.Signature;
import java.security.cert.Certificate;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

/**
 * The server's key in {@code java.security}: SHA256withRSA (PKCS#1 v1.5) or SHA256withECDSA in DER, for the handoff's
 * algorithm and no other, with the key proven to be the certificate's. Over the PDF kernel's signing fixtures (the
 * host side of {@code kernel-signature.test.ts}'s {@code hostSign}).
 */
class KeyStorePdfSignerTest {

    private static final byte[] DATA = "the DER signed attributes".getBytes(StandardCharsets.US_ASCII);

    @ParameterizedTest
    @ValueSource(strings = {"rsa2048", "p256", "p384", "chain-leaf"})
    void signsTheFixtureKeysTheWayTheKernelAsks(String name) throws Exception {
        KeyStorePdfSigner signer = TestAssets.signer(name);
        String algorithm = ScriptedPdfRuntime.algorithmOf(signer.leaf());
        byte[] value = signer.sign(DATA, algorithm);
        String jca = algorithm.startsWith("RSA") ? "SHA256withRSA" : "SHA256withECDSA";
        Signature verifier = Signature.getInstance(jca);
        verifier.initVerify(signer.leaf().getPublicKey());
        verifier.update(DATA);
        assertThat(verifier.verify(value)).isTrue();
        if (!algorithm.startsWith("RSA")) {
            // DER, never r||s: a SEQUENCE of two INTEGERs, which the service checks too.
            assertThat(value[0]).isEqualTo((byte) 0x30);
            assertThat(PdfService.Der.isEcdsaSignature(value)).isTrue();
            assertThat(value.length).isNotEqualTo(name.equals("p256") ? 64 : 96);
        }
        assertThat(signer.certificatesBase64()).hasSize(name.equals("chain-leaf") ? 2 : 1);
        assertThat(signer.toString()).doesNotContain("PRIVATE");
    }

    @Test
    void refusesAnAlgorithmThatIsNotTheKeys() {
        KeyStorePdfSigner rsa = TestAssets.signer("rsa2048");
        assertThatThrownBy(() -> rsa.sign(DATA, "ECDSA-P256-SHA256")).isInstanceOf(PdfException.class)
            .satisfies(e -> assertThat(((PdfException) e).code()).isEqualTo("signature"));
        KeyStorePdfSigner p256 = TestAssets.signer("p256");
        assertThatThrownBy(() -> p256.sign(DATA, "ECDSA-P384-SHA256")).isInstanceOf(PdfException.class);
        assertThatThrownBy(() -> p256.sign(DATA, "RSASSA-PKCS1-v1_5-SHA256")).isInstanceOf(PdfException.class);
        assertThatThrownBy(() -> p256.sign(DATA, "RSASSA-PSS-SHA256")).isInstanceOf(PdfException.class)
            .hasMessageContaining("does not make");
    }

    @Test
    void refusesAKeyThatIsNotTheCertificates() {
        TsaKey rsa = TestAssets.identity("rsa2048");
        TsaKey other = TestAssets.identity("chain-leaf");
        assertThatThrownBy(() -> new KeyStorePdfSigner(rsa.privateKey(), other.chain())).isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("does not belong");
        assertThatThrownBy(() -> new KeyStorePdfSigner(rsa.privateKey(), List.of())).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void refusesAKeyTheKernelCannotUse() throws Exception {
        // A 1024-bit RSA certificate is refused before any PDF is signed.
        TsaKey small = selfSignedRsa(1024);
        assertThatThrownBy(() -> new KeyStorePdfSigner(small.privateKey(), small.chain())).isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("RSA 1024 bits");
    }

    @Test
    void anExpiredCertificateStillSigns() {
        // The kernel warns signature.certificateExpired; the key is the RSA fixture's.
        KeyStorePdfSigner expired = TestAssets.signer("expired");
        assertThat(expired.sign(DATA, "RSASSA-PKCS1-v1_5-SHA256")).isNotEmpty();
    }

    @Test
    void readsAPkcs12KeyStoreByAliasOrItsOnlyKey() throws Exception {
        TsaKey key = TestAssets.identity("chain-leaf");
        KeyStore store = KeyStore.getInstance("PKCS12");
        store.load(null, null);
        store.setKeyEntry("seal", key.privateKey(), "secret".toCharArray(), key.chain().toArray(new Certificate[0]));
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        store.store(out, "secret".toCharArray());
        KeyStorePdfSigner only = KeyStorePdfSigner.load(new ByteArrayInputStream(out.toByteArray()), null, "secret".toCharArray(), null, null);
        assertThat(only.chain()).hasSize(2);
        assertThat(only.keyAlgorithm()).isEqualTo("RSA-2048");
        KeyStorePdfSigner named = KeyStorePdfSigner.load(new ByteArrayInputStream(out.toByteArray()), "PKCS12", "secret".toCharArray(), "seal",
            "secret".toCharArray());
        assertThat(named.leaf()).isEqualTo(key.leaf());
        assertThatThrownBy(() -> KeyStorePdfSigner.load(new ByteArrayInputStream(out.toByteArray()), null, "wrong".toCharArray(), null, null))
            .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> KeyStorePdfSigner.fromKeyStore(store, "missing", "secret".toCharArray()))
            .isInstanceOf(IllegalArgumentException.class);

        TsaKey second = TestAssets.identity("p256");
        store.setKeyEntry("other", second.privateKey(), "secret".toCharArray(), second.chain().toArray(new Certificate[0]));
        assertThatThrownBy(() -> KeyStorePdfSigner.fromKeyStore(store, null, "secret".toCharArray()))
            .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("more than one key");
    }

    /** A self-signed RSA certificate of the given size, made with Bouncy Castle. */
    static TsaKey selfSignedRsa(int bits) throws Exception {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA");
        generator.initialize(bits);
        var pair = generator.generateKeyPair();
        var name = new org.bouncycastle.asn1.x500.X500Name("CN=Small key, O=Datum tests");
        var now = java.time.Instant.now();
        var builder = new org.bouncycastle.cert.jcajce.JcaX509v3CertificateBuilder(name, java.math.BigInteger.ONE,
            java.util.Date.from(now.minusSeconds(60)), java.util.Date.from(now.plusSeconds(86_400)), name, pair.getPublic());
        var signer = new org.bouncycastle.operator.jcajce.JcaContentSignerBuilder("SHA256withRSA").build(pair.getPrivate());
        var certificate = new org.bouncycastle.cert.jcajce.JcaX509CertificateConverter().getCertificate(builder.build(signer));
        return new TsaKey(pair.getPrivate(), List.of(certificate));
    }
}
