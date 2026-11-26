package com.argusvane.datum.timestamp.spring;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.timestamp.SelfSignedTsaCertificate;
import com.argusvane.datum.timestamp.TsaKey;
import com.argusvane.datum.timestamp.web.TsaHealth;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyStore;
import java.security.cert.X509Certificate;
import java.util.Base64;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.autoconfigure.ssl.SslAutoConfiguration;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;

/**
 * The timestamp server's signing key through a Spring Boot SSL bundle: {@code datum.tsa.signer.ssl-bundle}
 * names a {@code spring.ssl.bundle.jks.*} or {@code .pem.*} bundle; a bundle and self-signed together, an unknown bundle, a
 * bundle without a key store and a wrong bundle password stop the start naming the property, never a password.
 */
class TsaSigningBundleTest {

    @TempDir
    Path dir;

    private static ApplicationContextRunner runner() {
        return new ApplicationContextRunner()
            .withConfiguration(AutoConfigurations.of(SslAutoConfiguration.class, DatumTimestampAutoConfiguration.class))
            .withPropertyValues("datum.tsa.enabled=true", "datum.tsa.allow-memory-stores=true");
    }

    private Path keystore(String alias, String password) throws Exception {
        TsaKey key = SelfSignedTsaCertificate.create("Bundle TSA");
        KeyStore store = KeyStore.getInstance("PKCS12");
        store.load(null, null);
        store.setKeyEntry(alias, key.privateKey(), password.toCharArray(), key.chain().toArray(new X509Certificate[0]));
        Path file = dir.resolve("tsa.p12");
        try (OutputStream out = Files.newOutputStream(file)) {
            store.store(out, password.toCharArray());
        }
        return file;
    }

    @Test
    void aJksBundleIsTheSignersKey() throws Exception {
        Path file = keystore("tsa", "secret");
        runner().withPropertyValues("datum.tsa.signer.ssl-bundle=tsa", "spring.ssl.bundle.jks.tsa.keystore.location=file:" + file,
            "spring.ssl.bundle.jks.tsa.keystore.password=secret", "spring.ssl.bundle.jks.tsa.key.alias=tsa").run(context -> {
                assertThat(context).hasNotFailed();
                assertThat(context.getBean(TsaHealth.class).status().up()).isTrue();
                assertThat(context.getBean(TsaHealth.class).status().details()).containsEntry("certificate", "CN=Bundle TSA");
            });
        // The alias may be left out when the store holds one key.
        runner().withPropertyValues("datum.tsa.signer.ssl-bundle=tsa", "spring.ssl.bundle.jks.tsa.keystore.location=file:" + file,
            "spring.ssl.bundle.jks.tsa.keystore.password=secret").run(context -> assertThat(context.getBean(TsaHealth.class).status().up()).isTrue());
    }

    @Test
    void aPemBundleIsTheSignersKey() throws Exception {
        TsaKey key = SelfSignedTsaCertificate.create("Pem TSA");
        Path certificate = dir.resolve("tsa.crt");
        Files.writeString(certificate, key.chainPem());
        Path privateKey = dir.resolve("tsa.key");
        Files.writeString(privateKey, "-----BEGIN PRIVATE KEY-----\n"
            + Base64.getMimeEncoder(64, "\n".getBytes()).encodeToString(key.privateKey().getEncoded()) + "\n-----END PRIVATE KEY-----\n");
        runner().withPropertyValues("datum.tsa.signer.ssl-bundle=tsa", "spring.ssl.bundle.pem.tsa.keystore.certificate=file:" + certificate,
            "spring.ssl.bundle.pem.tsa.keystore.private-key=file:" + privateKey).run(context -> {
                assertThat(context).hasNotFailed();
                assertThat(context.getBean(TsaHealth.class).status().up()).isTrue();
                assertThat(context.getBean(TsaHealth.class).status().details()).containsEntry("certificate", "CN=Pem TSA");
            });
    }

    @Test
    void aWrongBundlePasswordStopsTheStartWithoutPrintingIt() throws Exception {
        Path file = keystore("tsa", "secret");
        runner().withPropertyValues("datum.tsa.signer.ssl-bundle=tsa", "spring.ssl.bundle.jks.tsa.keystore.location=file:" + file,
            "spring.ssl.bundle.jks.tsa.keystore.password=wrong-password").run(context -> {
                assertThat(context).hasFailed();
                StringBuilder all = new StringBuilder();
                for (Throwable t = context.getStartupFailure(); t != null; t = t.getCause()) {
                    all.append(t.getMessage()).append('\n');
                }
                assertThat(all.toString()).doesNotContain("wrong-password");
            });
    }

    @Test
    void aBundleWithSelfSignedAnUnknownBundleAndABundleWithoutAKeyStoreStopTheStart() throws Exception {
        Path file = keystore("tsa", "secret");
        String bundle = "spring.ssl.bundle.jks.tsa.keystore.location=file:" + file;
        runner().withPropertyValues("datum.tsa.signer.ssl-bundle=tsa", "datum.tsa.signer.self-signed=true", bundle, "spring.ssl.bundle.jks.tsa.keystore.password=secret")
            .run(context -> assertThat(context).hasFailed().getFailure().hasStackTraceContaining("not both"));
        runner().withPropertyValues("datum.tsa.signer.ssl-bundle=nowhere")
            .run(context -> assertThat(context).hasFailed().getFailure().hasStackTraceContaining("datum.tsa.signer.ssl-bundle").hasStackTraceContaining("nowhere"));
        runner().withPropertyValues("datum.tsa.signer.ssl-bundle=trust", "spring.ssl.bundle.jks.trust.truststore.location=file:" + file,
            "spring.ssl.bundle.jks.trust.truststore.password=secret")
            .run(context -> assertThat(context).hasFailed().getFailure().hasStackTraceContaining("holds no key store"));
    }
}
