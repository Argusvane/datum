package com.argusvane.datum.pdf.spring;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.sandbox.protocol.ProgramLimits;
import com.argusvane.datum.pdf.PdfRuntime;
import com.argusvane.datum.pdf.PdfService;
import com.argusvane.datum.pdf.ScriptedPdfRuntime;
import com.argusvane.datum.pdf.TestAssets;
import com.argusvane.datum.timestamp.TsaKey;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyStore;
import java.security.cert.Certificate;
import java.util.Base64;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.autoconfigure.ssl.SslAutoConfiguration;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;

/**
 * The PDF signer's key through a Spring Boot SSL bundle: {@code datum.pdf.signing.ssl-bundle} names a
 * {@code spring.ssl.bundle.jks.*} or {@code .pem.*} bundle; an unknown bundle and a key the bundle does not hold stop the
 * start naming the property, never a password.
 */
class SigningBundleTest {

    @TempDir
    Path dir;

    private static ApplicationContextRunner runner() {
        return new ApplicationContextRunner()
            .withConfiguration(AutoConfigurations.of(SslAutoConfiguration.class, DatumPdfAutoConfiguration.class))
            .withBean(PdfRuntime.class, () -> new ScriptedPdfRuntime().pdfRuntime())
            .withBean(ProgramLimits.class, ProgramLimits::defaults)
            .withUserConfiguration(com.argusvane.datum.pdf.MonitoringRegistries.class);
    }

    private Path keyStore(String password) throws Exception {
        TsaKey key = TestAssets.identity("chain-leaf");
        KeyStore store = KeyStore.getInstance("PKCS12");
        store.load(null, null);
        store.setKeyEntry("server", key.privateKey(), password.toCharArray(), key.chain().toArray(Certificate[]::new));
        Path file = dir.resolve("signer.p12");
        try (OutputStream out = Files.newOutputStream(file)) {
            store.store(out, password.toCharArray());
        }
        return file;
    }

    @Test
    void aJksBundleGivesTheServerSigner() throws Exception {
        Path store = keyStore("s3cret");
        runner().withPropertyValues("datum.pdf.signing.ssl-bundle=signer", "spring.ssl.bundle.jks.signer.keystore.location=file:" + store,
            "spring.ssl.bundle.jks.signer.keystore.password=s3cret", "spring.ssl.bundle.jks.signer.keystore.type=PKCS12",
            "spring.ssl.bundle.jks.signer.key.alias=server").run(context -> {
                assertThat(context).hasNotFailed();
                PdfService pdf = context.getBean(PdfService.class);
                assertThat(pdf.signer()).isNotNull();
                assertThat(pdf.signer().leaf().getSubjectX500Principal().getName()).contains("Datum forms office");
            });
    }

    @Test
    void aSeparateKeyPasswordAndTheOnlyKeyEntryWork() throws Exception {
        TsaKey key = TestAssets.identity("chain-leaf");
        KeyStore store = KeyStore.getInstance("PKCS12");
        store.load(null, null);
        // JDK PKCS#12 stores take one password for a store and its entries; the key password then equals the store's.
        store.setKeyEntry("only", key.privateKey(), "pw".toCharArray(), key.chain().toArray(Certificate[]::new));
        Path file = dir.resolve("other.p12");
        try (OutputStream out = Files.newOutputStream(file)) {
            store.store(out, "pw".toCharArray());
        }
        runner().withPropertyValues("datum.pdf.signing.ssl-bundle=signer", "spring.ssl.bundle.jks.signer.keystore.location=file:" + file,
            "spring.ssl.bundle.jks.signer.keystore.password=pw", "spring.ssl.bundle.jks.signer.key.password=pw")
            .run(context -> assertThat(context.getBean(PdfService.class).signer()).isNotNull());
    }

    @Test
    void aPemBundleGivesTheServerSigner() throws Exception {
        TsaKey key = TestAssets.identity("chain-leaf");
        Path certificate = dir.resolve("signer.crt");
        Files.writeString(certificate, key.chainPem());
        Path privateKey = dir.resolve("signer.key");
        Files.writeString(privateKey, "-----BEGIN PRIVATE KEY-----\n"
            + Base64.getMimeEncoder(64, "\n".getBytes()).encodeToString(key.privateKey().getEncoded()) + "\n-----END PRIVATE KEY-----\n");
        runner().withPropertyValues("datum.pdf.signing.ssl-bundle=signer", "spring.ssl.bundle.pem.signer.keystore.certificate=file:" + certificate,
            "spring.ssl.bundle.pem.signer.keystore.private-key=file:" + privateKey).run(context -> {
                assertThat(context).hasNotFailed();
                assertThat(context.getBean(PdfService.class).signer().leaf().getSubjectX500Principal().getName()).contains("Datum forms office");
            });
    }

    @Test
    void anEmptyBundleNameIsNoSigner() {
        runner().withPropertyValues("datum.pdf.signing.ssl-bundle=").run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context.getBean(PdfService.class).signer()).isNull();
        });
    }

    @Test
    void anUnknownBundleOrAKeyItDoesNotHoldStopsTheStartNamingTheProperty() throws Exception {
        runner().withPropertyValues("datum.pdf.signing.ssl-bundle=nowhere")
            .run(context -> assertThat(context).hasFailed().getFailure().hasStackTraceContaining("datum.pdf.signing.ssl-bundle")
                .hasStackTraceContaining("nowhere"));
        Path store = keyStore("s3cret");
        runner().withPropertyValues("datum.pdf.signing.ssl-bundle=signer", "spring.ssl.bundle.jks.signer.keystore.location=file:" + store,
            "spring.ssl.bundle.jks.signer.keystore.password=s3cret", "spring.ssl.bundle.jks.signer.key.alias=missing")
            .run(context -> assertThat(context).hasFailed().getFailure().hasStackTraceContaining("datum.pdf.signing.ssl-bundle")
                .hasStackTraceContaining("missing"));
        // A bundle with only a trust store holds no key store.
        runner().withPropertyValues("datum.pdf.signing.ssl-bundle=trust", "spring.ssl.bundle.jks.trust.truststore.location=file:" + store,
            "spring.ssl.bundle.jks.trust.truststore.password=s3cret")
            .run(context -> assertThat(context).hasFailed().getFailure().hasStackTraceContaining("holds no key store"));
    }

    @Test
    void aWrongBundlePasswordStopsTheStartWithoutPrintingIt() throws Exception {
        Path store = keyStore("s3cret");
        runner().withPropertyValues("datum.pdf.signing.ssl-bundle=signer", "spring.ssl.bundle.jks.signer.keystore.location=file:" + store,
            "spring.ssl.bundle.jks.signer.keystore.password=wrong-password").run(context -> {
                assertThat(context).hasFailed();
                Throwable root = context.getStartupFailure();
                StringBuilder all = new StringBuilder();
                for (Throwable t = root; t != null; t = t.getCause()) {
                    all.append(t.getMessage()).append('\n');
                }
                assertThat(all.toString()).doesNotContain("wrong-password");
            });
    }
}
