package com.argusvane.datum.pdf;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.sandbox.protocol.ProgramLimits;
import com.argusvane.datum.pdf.spring.DatumPdfAutoConfiguration;
import com.argusvane.datum.timestamp.InMemoryTsaLog;
import com.argusvane.datum.timestamp.TimestampAuthority;
import com.argusvane.datum.timestamp.TsaKey;
import com.argusvane.datum.timestamp.TsaKeyMaterial;
import com.argusvane.datum.web.monitoring.DatumCapabilities;
import com.argusvane.datum.web.monitoring.DatumHealthContributors;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyStore;
import java.security.cert.Certificate;
import java.time.Clock;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.autoconfigure.ssl.SslAutoConfiguration;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;

/**
 * The PDF capability's wiring without a web stack or a real runtime: the service from {@code datum.pdf.*}, the signer
 * from an SSL bundle, the timestamp source, the health check and the refusals that stop the start naming the property.
 */
class DatumPdfAutoConfigurationTest {

    private static ApplicationContextRunner runnerOver(PdfRuntime runtime) {
        return new ApplicationContextRunner()
            .withConfiguration(AutoConfigurations.of(DatumPdfAutoConfiguration.class))
            .withBean(PdfRuntime.class, () -> runtime)
            .withBean(ProgramLimits.class, ProgramLimits::defaults)
            .withUserConfiguration(MonitoringRegistries.class);
    }

    private final ApplicationContextRunner runner = runnerOver(new ScriptedPdfRuntime().pdfRuntime());

    private static Path keyStore(Path dir, String password) throws Exception {
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

    /** Two {@link PdfResultValidator} beans declared against their {@code @Order}. */
    @org.springframework.context.annotation.Configuration(proxyBeanMethods = false)
    static class ValidatorBeans {

        static final java.util.List<String> CALLS = java.util.Collections.synchronizedList(new java.util.ArrayList<>());

        @org.springframework.context.annotation.Bean
        @org.springframework.core.annotation.Order(2)
        PdfResultValidator refusesSecond() {
            return candidate -> {
                CALLS.add("second:" + candidate.op());
                return com.argusvane.datum.core.hooks.HookFindings.errors(
                    com.argusvane.datum.core.hooks.HookProblem.of("policy.pages", "At most one page."));
            };
        }

        @org.springframework.context.annotation.Bean
        @org.springframework.core.annotation.Order(1)
        PdfResultValidator warnsFirst() {
            return candidate -> {
                CALLS.add("first:" + candidate.op());
                return com.argusvane.datum.core.hooks.HookFindings.NONE;
            };
        }
    }

    @Test
    void theApplicationsResultValidatorsJudgeEveryPdfInTheirOrder() {
        ValidatorBeans.CALLS.clear();
        runner.withUserConfiguration(ValidatorBeans.class).run(context -> {
            assertThat(context).hasNotFailed();
            PdfService pdf = context.getBean(PdfService.class);
            org.assertj.core.api.Assertions.assertThatThrownBy(() -> pdf.render(TestAssets.JSON.createObjectNode(), PdfOptions.defaults()))
                .isInstanceOfSatisfying(com.argusvane.datum.core.hooks.HookRefusedException.class,
                    refused -> assertThat(refused.code()).isEqualTo("policy.pages"));
            assertThat(ValidatorBeans.CALLS).containsExactly("first:render", "second:render");
        });
    }

    /**
     * {@code datum.runtime.verify-max-bytes} is the verify route's cap, read by this binding (the key is shared with the other hosts) and
     * clamped to 1 to 100 MiB by {@code PdfSettings}.
     */
    @Test
    @org.junit.jupiter.api.extension.ExtendWith(org.springframework.boot.test.system.OutputCaptureExtension.class)
    void theVerifyCapIsARuntimePropertyAndIsClamped(org.springframework.boot.test.system.CapturedOutput output) {
        runner.run(context -> assertThat(context.getBean(PdfService.class).verifyMaxBytes()).isEqualTo(20 * 1024 * 1024));
        assertThat(output.getAll()).as("the default cap logs nothing").doesNotContain("verifyMaxBytes");
        runner.withPropertyValues("datum.runtime.verify-max-bytes=0").run(context ->
            assertThat(context.getBean(PdfService.class).verifyMaxBytes()).as("zero falls to the default").isEqualTo(20 * 1024 * 1024));
        assertThat(output.getAll()).contains("datum limit verifyMaxBytes = 0 is outside [1048576, 104857600]; using 20971520.");
        runner.withPropertyValues("datum.runtime.verify-max-bytes=5MB").run(context ->
            assertThat(context.getBean(PdfService.class).verifyMaxBytes()).isEqualTo(5 * 1024 * 1024));
        runner.withPropertyValues("datum.runtime.verify-max-bytes=1GB").run(context ->
            assertThat(context.getBean(PdfService.class).verifyMaxBytes()).as("clamped to 100 MiB, with a WARN").isEqualTo(100L * 1024 * 1024));
        runner.withPropertyValues("datum.runtime.verify-max-bytes=1KB").run(context -> {
            assertThat(context.getBean(PdfService.class).verifyMaxBytes()).as("clamped up to 1 MiB").isEqualTo(1024 * 1024);
            assertThat(context.getBean(com.argusvane.datum.pdf.config.PdfSettings.class).verifyMaxBytes()).isEqualTo(1024 * 1024);
        });
    }

    /** The property wins whatever {@code PdfSettings} bean exists. */
    @Test
    @org.junit.jupiter.api.extension.ExtendWith(org.springframework.boot.test.system.OutputCaptureExtension.class)
    void theVerifyCapPropertyAppliesToAnApplicationsOwnPdfSettingsBean(org.springframework.boot.test.system.CapturedOutput output) {
        com.argusvane.datum.pdf.config.PdfSettings mine = com.argusvane.datum.pdf.config.PdfSettings.defaults().withFonts("standard");
        runner.withBean(com.argusvane.datum.pdf.config.PdfSettings.class, () -> mine)
            .withPropertyValues("datum.runtime.verify-max-bytes=50MB").run(context -> {
                assertThat(context).hasNotFailed();
                PdfService pdf = context.getBean(PdfService.class);
                assertThat(pdf.verifyMaxBytes()).isEqualTo(50L * 1024 * 1024);
                byte[] thirtyMegabytes = new byte[30 * 1024 * 1024];
                org.assertj.core.api.Assertions.assertThatThrownBy(() -> pdf.verify(thirtyMegabytes))
                    .as("past the size check: it is refused as a non-PDF, not as too large")
                    .isNotInstanceOf(com.argusvane.datum.core.RequestTooLargeException.class)
                    .isInstanceOf(PdfException.class);
            });
        assertThat(output.getAll()).doesNotContain("verifyMaxBytes");
        // Without the property the application's own bean keeps its own cap.
        runner.withBean(com.argusvane.datum.pdf.config.PdfSettings.class, () -> mine.withVerifyMaxBytes(7L * 1024 * 1024)).run(context ->
            assertThat(context.getBean(PdfService.class).verifyMaxBytes()).isEqualTo(7L * 1024 * 1024));
        // A property outside the bounds on the application's bean is clamped there too, with the WARN.
        runner.withBean(com.argusvane.datum.pdf.config.PdfSettings.class, () -> mine)
            .withPropertyValues("datum.runtime.verify-max-bytes=1GB").run(context ->
                assertThat(context.getBean(PdfService.class).verifyMaxBytes()).isEqualTo(100L * 1024 * 1024));
        assertThat(output.getAll()).contains("datum limit verifyMaxBytes = 1073741824 is outside [1048576, 104857600]; using 104857600.");
    }

    @Test
    void theDefaultsGiveAServiceThatSealsNothing() {
        runner.run(context -> {
            assertThat(context).hasSingleBean(PdfService.class);
            PdfService pdf = context.getBean(PdfService.class);
            assertThat(pdf.signer()).isNull();
            assertThat(pdf.sealPreset().enabled()).isFalse();
            assertThat(pdf.timestampSource()).isEmpty();
            assertThat(pdf.timestampAvailable()).isFalse();
            assertThat(pdf.verifyMaxBytes()).isEqualTo(com.argusvane.datum.pdf.config.PdfSettings.VERIFY_DEFAULT_BYTES).isEqualTo(20 * 1024 * 1024);
            assertThat(context.getBean(DatumCapabilities.class).present()).contains("pdf");
            DatumHealthContributors.Status health = context.getBean(DatumHealthContributors.class).evaluate().get("pdf");
            assertThat(health.up()).isTrue();
            assertThat(health.details()).containsEntry("signing", false).containsEntry("sealing", false);
        });
    }

    /**
     * The PDF capability and health check are beans of their own over whichever {@link PdfService} the
     * context has, so an application's service keeps {@code datum/pdf} and the {@code info.datum} details.
     */
    @Test
    void anApplicationsServiceKeepsThePdfCheckAndCapability() {
        runner.withBean("applicationPdf", PdfService.class, () -> PdfService.builder().runtime(new ScriptedPdfRuntime().pdfRuntime()).build())
            .run(context -> {
                assertThat(context).hasNotFailed();
                assertThat(context.getBeansOfType(PdfService.class)).containsOnlyKeys("applicationPdf");
                assertThat(context.getBean(DatumCapabilities.class).present()).contains("pdf");
                assertThat(context.getBean(DatumCapabilities.class).details()).containsEntry("signing", false).containsEntry("timestamp", "none");
                assertThat(context.getBean(DatumHealthContributors.class).evaluate()).containsKey("pdf");
            });
    }

    @Test
    void theSignerAndThePresetComeFromTheProperties(@TempDir Path dir) throws Exception {
        Path store = keyStore(dir, "s3cret");
        runner.withConfiguration(AutoConfigurations.of(SslAutoConfiguration.class)).withPropertyValues("datum.pdf.signing.ssl-bundle=signer",
            "spring.ssl.bundle.jks.signer.keystore.location=file:" + store, "spring.ssl.bundle.jks.signer.keystore.password=s3cret",
            "datum.pdf.seal.enabled=true", "datum.pdf.seal.certify=formFill", "datum.pdf.seal.reason=Issued", "datum.pdf.fonts=standard",
            "datum.pdf.seal.posted-answers=true").run(context -> {
                assertThat(context).hasNotFailed();
                PdfService pdf = context.getBean(PdfService.class);
                assertThat(pdf.signer()).isNotNull();
                assertThat(pdf.signer().leaf().getSubjectX500Principal().getName()).contains("Datum forms office");
                assertThat(pdf.sealPreset().enabled()).isTrue();
                assertThat(pdf.sealPreset().reason()).isEqualTo("Issued");
                assertThat(pdf.trust().siteSigners().get()).as("the current signer is always the site's").hasSize(1);
                assertThat(context.getBean(DatumCapabilities.class).details()).containsEntry("signing", true).containsEntry("seal", true);
            });
    }

    @Test
    void anApplicationSignerBeanIsTheServerSigner() {
        PdfSigner mine = TestAssets.signer("p256");
        runner.withBean(PdfSigner.class, () -> mine).run(context -> assertThat(context.getBean(PdfService.class).signer()).isSameAs(mine));
    }

    @Test
    void aSettingThatCannotBeUsedStopsTheStartNamingTheProperty(@TempDir Path dir) throws Exception {
        runner.withPropertyValues("datum.pdf.fonts=comic").run(context -> assertThat(context).hasFailed().getFailure()
            .hasStackTraceContaining("datum.pdf.fonts"));
        runner.withPropertyValues("datum.pdf.seal.certify=bogus").run(context -> assertThat(context).hasFailed());
        runner.withPropertyValues("datum.pdf.signing.trust-anchors=file:" + dir.resolve("none.pem")).run(context -> assertThat(context).hasFailed());
    }

    @Test
    void theTimestampSourceIsANamedServerElseTheSitesOwnAuthority() {
        runner.withPropertyValues("datum.pdf.signing.tsa.url=https://tsa.example.org/tsa", "datum.pdf.signing.tsa.timeout=3s").run(context -> {
            PdfService pdf = context.getBean(PdfService.class);
            assertThat(pdf.timestampSource()).isEqualTo("https://tsa.example.org/tsa");
            assertThat(pdf.timestampAvailable()).isTrue();
        });
        TimestampAuthority authority = new TimestampAuthority(TsaKeyMaterial.of(TestAssets.identity("tsa")), null, null, Clock.systemUTC(),
            new InMemoryTsaLog(Clock.systemUTC()));
        runner.withBean(TimestampAuthority.class, () -> authority).withBean(TsaKeyMaterial.class, () -> TsaKeyMaterial.of(TestAssets.identity("tsa")))
            .run(context -> {
            PdfService pdf = context.getBean(PdfService.class);
            assertThat(pdf.timestampSource()).isEqualTo("site");
            assertThat(pdf.trust().siteTimestampCertificates().get()).as("the authority's current certificate").hasSize(1);
        });
        // A named server wins over the site's authority.
        runner.withBean(TimestampAuthority.class, () -> authority).withPropertyValues("datum.pdf.signing.tsa.url=https://tsa.example.org/tsa")
            .run(context -> assertThat(context.getBean(PdfService.class).timestampSource()).startsWith("https://"));
    }

    @Test
    void theCapabilityIsOffWhenAskedAndAPlatformThatCannotPrintIsUpWithAReasonNotDown() {
        runner.withPropertyValues("datum.pdf.enabled=false").run(context -> assertThat(context).doesNotHaveBean(PdfService.class));
        runner.withPropertyValues("datum.enabled=false").run(context -> assertThat(context).doesNotHaveBean(PdfService.class));
        runnerOver(new ScriptedPdfRuntime().pdfRuntime("bytecode", 1)).run(context -> {
            DatumHealthContributors.Status health = context.getBean(DatumHealthContributors.class).evaluate().get("pdf");
            // A permanent platform fact (the bytecode runner) is not an outage: UP, so a readiness probe does not
            // restart the pod for ever, with the reason beside available:false.
            assertThat(health.up()).isTrue();
            assertThat(health.details()).containsEntry("available", false).containsKey("reason").containsEntry("engineMode", "bytecode")
                .containsEntry("engine", "scripted");
        });
    }

    // ------------------------------------------------------------------------------------------------------ fonts

    /** The font faces are a bean the service takes (an application's own replaces them); {@code datum.pdf.fonts} still picks the pack. */
    @Test
    void thePdfFontsAreABeanTheServiceTakes() {
        runner.run(context -> {
            assertThat(context).hasSingleBean(PdfFonts.class);
            assertThat(org.springframework.test.util.ReflectionTestUtils.getField(context.getBean(PdfService.class), "fonts"))
                .isSameAs(context.getBean(PdfFonts.class));
        });
        PdfFonts mine = new PdfFonts(name -> null);
        runner.withBean(PdfFonts.class, () -> mine).withPropertyValues("datum.pdf.fonts=all").run(context -> {
            assertThat(context).hasSingleBean(PdfFonts.class);
            PdfService pdf = context.getBean(PdfService.class);
            assertThat(org.springframework.test.util.ReflectionTestUtils.getField(pdf, "fonts")).isSameAs(mine);
            assertThat(org.springframework.test.util.ReflectionTestUtils.getField(pdf, "defaultPack")).isEqualTo(PdfFonts.Pack.ALL);
        });
    }

    @Test
    void anApplicationsPdfSettingsBeanReplacesTheOneFromProperties() {
        com.argusvane.datum.pdf.config.PdfSettings mine = new com.argusvane.datum.pdf.config.PdfSettings(true, "standard", null, null);
        runner.withBean(com.argusvane.datum.pdf.config.PdfSettings.class, () -> mine).withPropertyValues("datum.pdf.fonts=all").run(context -> {
            assertThat(context).hasSingleBean(com.argusvane.datum.pdf.config.PdfSettings.class);
            assertThat(org.springframework.test.util.ReflectionTestUtils.getField(context.getBean(PdfService.class), "defaultPack"))
                .isEqualTo(PdfFonts.Pack.STANDARD);
        });
    }

    /** {@code datum.pdf.signing.tsa.policy}: the client asks every server for that reqPolicy; a bad object identifier stops the start. */
    @Test
    void theTimestampPolicyReachesTheClient() {
        runner.withPropertyValues("datum.pdf.signing.tsa.url=http://127.0.0.1:9/tsa", "datum.pdf.signing.tsa.policy=1.2.3.4").run(context -> {
            assertThat(context).hasNotFailed();
            Object client = org.springframework.test.util.ReflectionTestUtils.getField(context.getBean(PdfService.class), "timestamper");
            assertThat(client).isInstanceOf(com.argusvane.datum.timestamp.TimestampClient.class);
            assertThat(((com.argusvane.datum.timestamp.TimestampClient) client).policy()).isEqualTo("1.2.3.4");
        });
        runner.withPropertyValues("datum.pdf.signing.tsa.url=http://127.0.0.1:9/tsa").run(context -> assertThat(
            ((com.argusvane.datum.timestamp.TimestampClient) org.springframework.test.util.ReflectionTestUtils.getField(
                context.getBean(PdfService.class), "timestamper")).policy()).as("unset: none").isNull());
        runner.withPropertyValues("datum.pdf.signing.tsa.url=http://127.0.0.1:9/tsa", "datum.pdf.signing.tsa.policy=not-an-oid").run(context -> {
            assertThat(context).hasFailed();
            assertThat(context.getStartupFailure()).hasStackTraceContaining("datum.pdf.signing.tsa").hasStackTraceContaining("not-an-oid");
        });
    }

    // ------------------------------------------------------------------------------------------------------ recording timestamper

    /** A recording timestamper: what an application's qualified or custom authority looks like to the binding. */
    static final class RecordingTimestamper implements com.argusvane.datum.timestamp.Timestamper {

        final java.util.List<String> channels = new java.util.concurrent.CopyOnWriteArrayList<>();

        @Override
        public byte[] stamp(byte[] data, String channel) {
            channels.add(channel);
            return new byte[0];
        }
    }

    /** The application's Timestamper bean is consulted before the binding builds its own client: it wins over the URL and the site's authority. */
    @Test
    void anApplicationsTimestamperIsUsedBeforeTheNamedServerOrTheSitesAuthority() {
        RecordingTimestamper mine = new RecordingTimestamper();
        TimestampAuthority authority = new TimestampAuthority(TsaKeyMaterial.of(TestAssets.identity("tsa")), null, null, Clock.systemUTC(),
            new InMemoryTsaLog(Clock.systemUTC()));
        runner.withBean(com.argusvane.datum.timestamp.Timestamper.class, () -> mine)
            .withBean(TimestampAuthority.class, () -> authority)
            .withPropertyValues("datum.pdf.signing.tsa.url=https://tsa.example.org/tsa")
            .run(context -> {
                assertThat(context).hasNotFailed();
                assertThat(context).doesNotHaveBean(com.argusvane.datum.timestamp.TimestampClient.class);
                PdfService pdf = context.getBean(PdfService.class);
                assertThat(org.springframework.test.util.ReflectionTestUtils.getField(pdf, "timestamper")).isSameAs(mine);
                assertThat(pdf.timestampSource()).isEqualTo("custom");
                assertThat(context.getBean(DatumCapabilities.class).details()).containsEntry("timestamp", "custom");
            });
        // Without one, the named server's client is a bean, and it wins over the site's authority.
        runner.withBean(TimestampAuthority.class, () -> authority).withPropertyValues("datum.pdf.signing.tsa.url=https://tsa.example.org/tsa")
            .run(context -> {
                assertThat(context).hasSingleBean(com.argusvane.datum.timestamp.TimestampClient.class);
                assertThat(org.springframework.test.util.ReflectionTestUtils.getField(context.getBean(PdfService.class), "timestamper"))
                    .isSameAs(context.getBean(com.argusvane.datum.timestamp.TimestampClient.class));
                assertThat(context.getBean(DatumCapabilities.class).details()).containsEntry("timestamp", "server");
            });
        // An empty URL names no server.
        runner.withPropertyValues("datum.pdf.signing.tsa.url=").run(context -> {
            assertThat(context.getBeanProvider(com.argusvane.datum.timestamp.TimestampClient.class).getIfAvailable()).as("a null bean").isNull();
            assertThat(context.getBean(PdfService.class).timestampSource()).isEmpty();
        });
    }

    /**
     * The named server's client is built from the PdfSettings bean, not the property, so an application's own
     * settings bean that names a server gets its client (with its reqPolicy), and one that names none wins over the property.
     */
    @Test
    void anApplicationsPdfSettingsBeanNamingAServerGetsItsClient() {
        com.argusvane.datum.pdf.config.PdfSettings.Signing signing = new com.argusvane.datum.pdf.config.PdfSettings.Signing(
            null, null,
            new com.argusvane.datum.pdf.config.PdfSettings.Tsa("https://tsa.example.org/tsa", null, null, null, null, "1.2.3.4"));
        com.argusvane.datum.pdf.config.PdfSettings named = new com.argusvane.datum.pdf.config.PdfSettings(true, "default", signing, null);
        runner.withBean(com.argusvane.datum.pdf.config.PdfSettings.class, () -> named).run(context -> {
            assertThat(context).hasNotFailed();
            PdfService pdf = context.getBean(PdfService.class);
            assertThat(pdf.timestampSource()).isEqualTo("https://tsa.example.org/tsa");
            assertThat(context.getBean(com.argusvane.datum.timestamp.TimestampClient.class).policy()).isEqualTo("1.2.3.4");
            assertThat(context.getBean(DatumCapabilities.class).details()).containsEntry("timestamp", "server");
        });
        com.argusvane.datum.pdf.config.PdfSettings none = com.argusvane.datum.pdf.config.PdfSettings.defaults();
        runner.withBean(com.argusvane.datum.pdf.config.PdfSettings.class, () -> none)
            .withPropertyValues("datum.pdf.signing.tsa.url=https://tsa.example.org/tsa").run(context -> {
                assertThat(context).hasNotFailed();
                assertThat(context.getBean(PdfService.class).timestampSource()).as("the bean names no server: it wins").isEmpty();
                assertThat(context.getBeanProvider(com.argusvane.datum.timestamp.TimestampClient.class).getIfAvailable()).isNull();
            });
    }

    /** The application's Timestamper leaves the datum.pdf.signing.tsa.* settings unused, and the start says so. */
    @Test
    @org.junit.jupiter.api.extension.ExtendWith(org.springframework.boot.test.system.OutputCaptureExtension.class)
    void theTimestampSettingsAnApplicationsTimestamperLeavesUnusedAreNamed(org.springframework.boot.test.system.CapturedOutput output) {
        runner.withBean(com.argusvane.datum.timestamp.Timestamper.class, RecordingTimestamper::new)
            .withPropertyValues("datum.pdf.signing.tsa.url=https://tsa.example.org/tsa", "datum.pdf.signing.tsa.policy=0.4.0.2023.1.1",
                "datum.pdf.signing.tsa.bearer-token=secret-token")
            .run(context -> {
                assertThat(context).hasNotFailed();
                assertThat(output).contains("does not use datum.pdf.signing.tsa.policy (0.4.0.2023.1.1)")
                    .contains("datum.pdf.signing.tsa.url, datum.pdf.signing.tsa.bearer-token are not used")
                    .doesNotContain("secret-token");
            });
    }

    @Test
    void twoTimestampersStopTheStartUnlessOneIsPrimary() {
        runner.withBean("first", com.argusvane.datum.timestamp.Timestamper.class, RecordingTimestamper::new)
            .withBean("second", com.argusvane.datum.timestamp.Timestamper.class, RecordingTimestamper::new)
            .run(context -> assertThat(context).hasFailed().getFailure().hasStackTraceContaining("2 Timestamper beans"));
        RecordingTimestamper primary = new RecordingTimestamper();
        runner.withBean("first", com.argusvane.datum.timestamp.Timestamper.class, RecordingTimestamper::new)
            .withBean("second", com.argusvane.datum.timestamp.Timestamper.class, () -> primary, definition -> definition.setPrimary(true))
            .run(context -> assertThat(org.springframework.test.util.ReflectionTestUtils.getField(context.getBean(PdfService.class), "timestamper"))
                .isSameAs(primary));
    }

    /** The trust policy and the verifier are beans the service takes; the defaults are the stock trust policy and verifier. */
    @Test
    void theTrustPolicyAndTheVerifierAreBeansTheServiceTakes() {
        runner.run(context -> {
            PdfService pdf = context.getBean(PdfService.class);
            assertThat(pdf.verifier()).isSameAs(context.getBean(com.argusvane.datum.pdf.verify.PdfVerifier.class));
            assertThat(pdf.verifier().policy().name()).isEqualTo("default");
            assertThat(pdf.verifier().policy().revocationChecking()).isFalse();
            assertThat(pdf.verifier().policy().validationTime()).isEqualTo(com.argusvane.datum.pdf.verify.PdfTrustPolicy.ValidationTime.NOW);
        });
        com.argusvane.datum.pdf.verify.PdfTrustPolicy strict = com.argusvane.datum.pdf.verify.PdfTrustPolicy.builder("strict")
            .revocationChecking(true).validationTime(com.argusvane.datum.pdf.verify.PdfTrustPolicy.ValidationTime.SIGNING_TIME).build();
        PdfSigner signer = TestAssets.signer("p256");
        runner.withBean(com.argusvane.datum.pdf.verify.PdfTrustPolicy.class, () -> strict).withBean(PdfSigner.class, () -> signer)
            .run(context -> {
                PdfService pdf = context.getBean(PdfService.class);
                assertThat(pdf.verifier().policy()).isSameAs(strict);
                assertThat(pdf.trust().siteSigners().get()).as("the server's own signer is the site's").containsExactly(signer.leaf());
            });
        com.argusvane.datum.pdf.verify.PdfVerifier mine = new com.argusvane.datum.pdf.verify.PdfVerifier(
            com.argusvane.datum.pdf.verify.PdfTrust.none(Clock.systemUTC()), com.argusvane.datum.core.contracts.DatumJson.mapper()) {
        };
        runner.withBean(com.argusvane.datum.pdf.verify.PdfVerifier.class, () -> mine)
            .run(context -> assertThat(context.getBean(PdfService.class).verifier()).isSameAs(mine));
    }
}
