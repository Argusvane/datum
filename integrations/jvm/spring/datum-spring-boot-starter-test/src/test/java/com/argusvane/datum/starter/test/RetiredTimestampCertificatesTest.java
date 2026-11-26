package com.argusvane.datum.starter.test;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.forms.spring.DatumFormsAutoConfiguration;
import com.argusvane.datum.forms.spring.DatumFormsWebAutoConfiguration;
import com.argusvane.datum.pdf.verify.PdfTrust;
import com.argusvane.datum.pdf.spring.DatumPdfAutoConfiguration;
import com.argusvane.datum.springweb.autoconfigure.DatumWebAutoConfiguration;
import com.argusvane.datum.sandbox.spring.DatumSandboxAutoConfiguration;
import com.argusvane.datum.submissions.spring.DatumSubmissionsAutoConfiguration;
import com.argusvane.datum.timestamp.SelfSignedTsaCertificate;
import com.argusvane.datum.timestamp.TsaKey;
import com.argusvane.datum.timestamp.TsaKeyMaterial;
import com.argusvane.datum.timestamp.spring.DatumTimestampAutoConfiguration;
import com.argusvane.datum.timestamp.web.TsaCertificates;
import com.argusvane.datum.timestamp.web.TsaSettings;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.cert.X509Certificate;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.runner.WebApplicationContextRunner;

/**
 * {@code datum.tsa.retired-certificates} is read one way by both modules that use it: the timestamp server
 * (which publishes the chains) and the PDF verifier (which places the tokens those keys made). A bare path is a file for both;
 * the PDF module handed it to the resource loader before, where it was a class-path or servlet-context resource, so a host
 * with both modules on and a path such as {@code /etc/datum/old-tsa.pem} did not start. With the timestamp server on, the PDF
 * module reads its {@link TsaSettings} bean, so an application's own settings bean decides for both.
 */
class RetiredTimestampCertificatesTest {

    @TempDir
    Path dir;

    private static final Class<?>[] PDF = {DatumWebAutoConfiguration.class, DatumFormsAutoConfiguration.class,
        DatumFormsWebAutoConfiguration.class, DatumSandboxAutoConfiguration.class, DatumSubmissionsAutoConfiguration.class, DatumPdfAutoConfiguration.class};

    private WebApplicationContextRunner runner(Class<?>... configurations) {
        return new WebApplicationContextRunner().withConfiguration(AutoConfigurations.of(DatumTestAutoConfiguration.class, DatumTestFormsAutoConfiguration.class))
            .withPropertyValues("datum.test.forms=true")
            .withConfiguration(AutoConfigurations.of(configurations));
    }

    private static Class<?>[] withTimestamp() {
        Class<?>[] all = java.util.Arrays.copyOf(PDF, PDF.length + 1);
        all[PDF.length] = DatumTimestampAutoConfiguration.class;
        return all;
    }

    private X509Certificate retired(String name) throws Exception {
        TsaKey key = SelfSignedTsaCertificate.create("Retired " + name);
        Files.writeString(dir.resolve(name + ".pem"), key.chainPem());
        return key.leaf();
    }

    @Test
    void aBarePathIsAFileForBothModules() throws Exception {
        X509Certificate old = retired("old-tsa");
        String bare = dir.resolve("old-tsa.pem").toAbsolutePath().toString();
        assertThat(bare).doesNotContain(":");
        runner(withTimestamp()).withPropertyValues("datum.tsa.enabled=true", "datum.tsa.allow-memory-stores=true", "datum.tsa.signer.self-signed=true",
            "datum.tsa.retired-certificates=" + bare).run(context -> {
                assertThat(context).hasNotFailed();
                assertThat(context.getBean(PdfTrust.class).siteTimestampCertificates().get()).contains(old);
            });
    }

    @Test
    void aPdfOnlyHostReadsThePropertyWithTheSameRule() throws Exception {
        X509Certificate old = retired("pdf-only");
        String bare = dir.resolve("pdf-only.pem").toAbsolutePath().toString();
        runner(PDF).withPropertyValues("datum.tsa.retired-certificates=" + bare).run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context.getBean(PdfTrust.class).siteTimestampCertificates().get()).containsExactly(old);
        });
    }

    @Test
    void anApplicationsTsaSettingsBeanDecidesForThePdfModuleToo() throws Exception {
        X509Certificate mine = retired("mine");
        com.argusvane.datum.timestamp.spring.DatumTsaProperties properties = new com.argusvane.datum.timestamp.spring.DatumTsaProperties();
        properties.setEnabled(true);
        properties.setAllowMemoryStores(true);
        properties.getSigner().setSelfSigned(true);
        properties.setRetiredCertificates(java.util.List.of(dir.resolve("mine.pem").toString()));
        TsaSettings settings = properties.toSettings();
        runner(withTimestamp()).withBean(TsaSettings.class, () -> settings)
            .withPropertyValues("datum.tsa.enabled=true", "datum.tsa.allow-memory-stores=true", "datum.tsa.signer.self-signed=true",
                "datum.tsa.retired-certificates=" + dir.resolve("absent.pem")).run(context -> {
                    assertThat(context).hasNotFailed();
                    assertThat(context.getBean(PdfTrust.class).siteTimestampCertificates().get()).contains(mine);
                });
    }

    /** An application's certificate list, its retired chains from a key vault, say. */
    @org.springframework.context.annotation.Configuration(proxyBeanMethods = false)
    static class VaultCertificates {

        static final TsaKey VAULT = SelfSignedTsaCertificate.create("Retired in the vault");

        @org.springframework.context.annotation.Bean
        TsaCertificates applicationTsaCertificates(TsaKeyMaterial keys) {
            return new TsaCertificates(keys, java.util.List.of(VAULT.chain()));
        }
    }

    /**
     * The chains {@code /tsa/certificates} publishes are the ones the PDF verifier places, also when the application replaced
     * the {@link TsaCertificates} bean (its retired chains from elsewhere, the property empty): the PDF module reads that bean,
     * not the settings again, so a PDF timestamped by a key the list names does not verify as an unknown authority.
     */
    @Test
    void anApplicationsCertificateListIsWhatThePdfVerifierPlaces() {
        runner(withTimestamp()).withUserConfiguration(VaultCertificates.class)
            .withPropertyValues("datum.tsa.enabled=true", "datum.tsa.allow-memory-stores=true", "datum.tsa.signer.self-signed=true")
            .run(context -> {
                assertThat(context).hasNotFailed();
                assertThat(context.getBeansOfType(TsaCertificates.class)).containsOnlyKeys("applicationTsaCertificates");
                String published = new String(context.getBean(TsaCertificates.class).certificates().body(), java.nio.charset.StandardCharsets.US_ASCII);
                assertThat(published).contains(TsaKey.pem(VaultCertificates.VAULT.leaf()));
                assertThat(context.getBean(PdfTrust.class).siteTimestampCertificates().get()).contains(VaultCertificates.VAULT.leaf());
            });
    }
}
