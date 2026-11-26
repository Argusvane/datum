package com.argusvane.datum.timestamp;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyStore;
import java.security.cert.Certificate;
import java.time.Clock;
import java.time.Instant;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** The key from a PKCS#12 store: read once, checked at every use, refused with a reason. */
class KeyStoreTsaKeyMaterialTest {

    private static final char[] PASSWORD = "changeit".toCharArray();

    private static KeyStore store(String alias, TsaKey key, Certificate... chain) throws Exception {
        KeyStore store = KeyStore.getInstance("PKCS12");
        store.load(null, null);
        store.setKeyEntry(alias, key.privateKey(), PASSWORD, chain.length > 0 ? chain : key.chain().toArray(Certificate[]::new));
        return store;
    }

    @Test
    void readsTheKeyAndItsChainFromAFile(@TempDir Path dir) throws Exception {
        TsaKey key = Fixtures.key("tsa");
        Path file = dir.resolve("tsa.p12");
        try (var out = Files.newOutputStream(file)) {
            store("tsa", key).store(out, PASSWORD);
        }
        KeyStoreTsaKeyMaterial material = KeyStoreTsaKeyMaterial.open(file, "PKCS12", PASSWORD, null, null, Fixtures.clock(Fixtures.LATER));
        TsaKey loaded = material.load();
        assertThat(loaded.leaf()).isEqualTo(key.leaf());
        assertThat(loaded.fingerprint()).isEqualTo(key.fingerprint());
        assertThat(loaded.toString()).doesNotContain("PRIVATE");
        assertThat(material.load()).isSameAs(loaded);
        // It issues tokens.
        TimestampAuthority authority = new TimestampAuthority(material, null, null, Clock.systemUTC(), entry -> 1);
        assertThat(authority.respond(TimestampQuery.forData(new byte[] {1}), null).status()).isEqualTo(200);
    }

    @Test
    void refusesAnExpiredCertificateAtUse() throws Exception {
        KeyStoreTsaKeyMaterial material = new KeyStoreTsaKeyMaterial(store("tsa", Fixtures.key("ec-p256")), "tsa", PASSWORD,
            Clock.fixed(Instant.parse("2200-01-01T00:00:00Z"), java.time.ZoneOffset.UTC));
        assertThatThrownBy(material::load).isInstanceOf(TsaKeyException.class)
            .hasMessage("The certificate CN=Datum test TSA ec, O=Datum tests expired on 2126-09-21.");
    }

    @Test
    void refusesACertificateThatIsNotATimestampServers() throws Exception {
        KeyStoreTsaKeyMaterial material = new KeyStoreTsaKeyMaterial(store("x", Fixtures.key("eku-extra")), null, PASSWORD, Fixtures.clock(Fixtures.LATER));
        assertThatThrownBy(material::load).isInstanceOf(TsaKeyException.class).hasMessageContaining("its only extended key usage");
    }

    @Test
    void refusesAKeyThatIsNotTheCertificates() throws Exception {
        KeyStore store = store("tsa", Fixtures.key("ec-p256"));
        // The ec-p256 key under another EC certificate.
        store.setKeyEntry("tsa", Fixtures.key("ec-p256").privateKey(), PASSWORD, new Certificate[] {Fixtures.certificate("eku-extra")});
        assertThatThrownBy(() -> new KeyStoreTsaKeyMaterial(store, "tsa", PASSWORD, Fixtures.clock(Fixtures.LATER)).load())
            .hasMessage("No certificate given is the private key’s: the key and the certificate do not match.");
    }

    @Test
    void namesWhatIsMissing() throws Exception {
        KeyStore empty = KeyStore.getInstance("PKCS12");
        empty.load(null, null);
        assertThatThrownBy(() -> new KeyStoreTsaKeyMaterial(empty, null, PASSWORD, Clock.systemUTC()).load()).hasMessage("The key store holds no private key.");
        KeyStore two = store("a", Fixtures.key("ec-p256"));
        two.setKeyEntry("b", Fixtures.key("rsa-2048").privateKey(), PASSWORD, Fixtures.key("rsa-2048").chain().toArray(Certificate[]::new));
        assertThatThrownBy(() -> new KeyStoreTsaKeyMaterial(two, null, PASSWORD, Clock.systemUTC()).load())
            .hasMessage("The key store holds 2 keys: name the timestamp server's alias.");
        assertThatThrownBy(() -> new KeyStoreTsaKeyMaterial(two, "c", PASSWORD, Clock.systemUTC()).load())
            .hasMessage("The key store holds no key under the alias c.");
        assertThatThrownBy(() -> KeyStoreTsaKeyMaterial.open(Path.of("/nonexistent/tsa.p12"), "PKCS12", PASSWORD, null, null, Clock.systemUTC()))
            .isInstanceOf(TsaKeyException.class).hasMessageStartingWith("The timestamp server key store /nonexistent/tsa.p12 cannot be opened");
    }

    @Test
    void pemTextNeedsAKeyAndACertificate() {
        assertThatThrownBy(() -> TsaKey.fromPem(Fixtures.text("tsa.cert.pem")))
            .hasMessage("There is no private key: give it with the certificate (PEM or PKCS#12), or apart.");
        assertThatThrownBy(() -> TsaKey.fromPem(Fixtures.text("tsa.key.pem"))).hasMessage("There is no certificate: give the key’s certificate with it.");
        // Certificates in any order: the key's own comes first.
        TsaKey key = TsaKey.fromPem(Fixtures.text("ec-p256.cert.pem") + Fixtures.text("tsa.cert.pem") + Fixtures.text("tsa.key.pem"));
        assertThat(key.leaf()).isEqualTo(Fixtures.certificate("tsa"));
        assertThat(key.chain()).hasSize(1);
    }
}
