package com.argusvane.datum.tck;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import static org.junit.jupiter.api.Assumptions.assumeTrue;
import static org.junit.platform.engine.discovery.DiscoverySelectors.selectClass;

import java.io.PrintWriter;
import java.io.StringWriter;
import java.math.BigInteger;
import java.net.http.HttpRequest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.EnumSet;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import org.junit.jupiter.api.MethodOrderer;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestMethodOrder;
import org.junit.platform.launcher.LauncherDiscoveryRequest;
import org.junit.platform.launcher.core.LauncherDiscoveryRequestBuilder;
import org.junit.platform.launcher.core.LauncherFactory;
import org.junit.platform.launcher.listeners.SummaryGeneratingListener;
import org.junit.platform.launcher.listeners.TestExecutionSummary;

/** The kit's own parts, without a host: the DER it writes and reads, the target it reads from properties, its fixtures. */
class KitTest {

    @Test
    void aTimeStampRequestIsTheDerOpensslWrites() {
        byte[] digest = new byte[32];
        for (int i = 0; i < digest.length; i++) {
            digest[i] = (byte) i;
        }
        byte[] query = Der.timeStampRequest(digest, BigInteger.valueOf(0x0102030405L));
        Der.Element request = Der.parse(query);
        assertThat(request.tag()).isEqualTo(0x30);
        assertThat(request.children()).hasSize(4);
        assertThat(request.children().get(0).integer()).isEqualTo(BigInteger.ONE);
        Der.Element imprint = request.children().get(1);
        assertThat(imprint.children().get(1).content()).isEqualTo(digest);
        assertThat(imprint.children().get(0).children().get(0).content())
            .as("the SHA-256 OID").containsExactly(0x60, 0x86 - 256, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01);
        assertThat(request.children().get(2).integer()).isEqualTo(BigInteger.valueOf(0x0102030405L));
        assertThat(request.children().get(3).tag()).as("certReq").isEqualTo(0x01);
        assertThat(Der.contains(query, digest)).isTrue();
        assertThat(Der.contains(query, new byte[] {9, 9, 9})).isFalse();
    }

    @Test
    void aLongElementAndAPkiStatusAreRead() {
        // A TimeStampResp of a rejection: SEQUENCE { SEQUENCE { INTEGER 2 } }.
        assertThat(Der.pkiStatus(new byte[] {0x30, 0x05, 0x30, 0x03, 0x02, 0x01, 0x02})).isEqualTo(2);
        byte[] big = new byte[300];
        byte[] der = new byte[304];
        der[0] = 0x04;
        der[1] = (byte) 0x82;
        der[2] = 0x01;
        der[3] = 0x2c;
        System.arraycopy(big, 0, der, 4, 300);
        assertThat(Der.parse(der).content()).hasSize(300);
        assertThatThrownBy(() -> Der.parse(new byte[] {0x30, (byte) 0x80, 0, 0})).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void aTargetIsReadFromProperties() {
        Properties properties = new Properties();
        properties.setProperty("datum.tck.base-url", "https://forms.example/app/");
        properties.setProperty("datum.tck.capabilities", "submissions, submissions-test,FLOOD");
        properties.setProperty("datum.tck.api-path", "/v1");
        properties.setProperty("datum.tck.builder-enabled", "true");
        properties.setProperty("datum.tck.build-form", "intake");
        properties.setProperty("datum.tck.header.X-Tenant", "a");
        properties.setProperty("datum.tck.person.header.Authorization", "Bearer p");
        HostTarget target = HostTck.target(properties);
        assertThat(target.baseUrl()).isEqualTo("https://forms.example/app");
        assertThat(target.api("/submissions")).isEqualTo("https://forms.example/app/v1/submissions");
        assertThat(target.assetsPath()).isEqualTo("/datum/assets");
        assertThat(target.capabilities()).containsExactlyInAnyOrder(Capability.SUBMISSIONS, Capability.SUBMISSIONS_TEST, Capability.FLOOD);
        assertThat(target.builderEnabled()).isTrue();
        assertThat(target.buildForm()).isEqualTo("intake");
        assertThat(target.headers()).containsEntry("X-Tenant", "a");
        HttpRequest.Builder request = HttpRequest.newBuilder(java.net.URI.create("https://forms.example/"));
        target.decorator().decorate(request, "GET", HostTarget.Who.PERSON);
        assertThat(request.build().headers().firstValue("Authorization")).hasValue("Bearer p");
        HttpRequest.Builder visitor = HttpRequest.newBuilder(java.net.URI.create("https://forms.example/"));
        target.decorator().decorate(visitor, "GET", HostTarget.Who.VISITOR);
        assertThat(visitor.build().headers().map()).isEmpty();
        assertThatThrownBy(() -> HostTck.target(new Properties())).hasMessageContaining("base-url");
        assertThat(Capability.of("runtime-down")).isEqualTo(Capability.RUNTIME_DOWN);
        assertThat(Capability.SUBMISSIONS_TEST.key()).isEqualTo("submissions-test");
    }

    @Test
    void theFixturesAreTheSuitesControlVectors() {
        assertThat(TckFixtures.form().path("id").asString()).isEqualTo(TckFixtures.FORM);
        assertThat(TckFixtures.form().path("version").asString()).isEqualTo(TckFixtures.VERSION);
        assertThat(TckFixtures.goldenErrors("CTL-02")).containsExactly("required@name");
        assertThat(TckFixtures.golden().path("controls").path("CTL-01").path("accepted").asBoolean()).isTrue();
        assertThat(TckFixtures.envelope("CTL-04").path("submission").path("values").path("code").asString()).isEqualTo("abc");
        assertThat(TckFixtures.wrapped(TckFixtures.envelope("CTL-01"))).startsWith("{\"document\":{\"versionContext\":");
        assertThat(new String(TckFixtures.formBytes(), java.nio.charset.StandardCharsets.UTF_8)).contains(TckFixtures.SECRET_MARKER);
    }

    // A contract-shaped probe: the names sort alphabetically against their @Order, so JUnit's default (and an
    // alphabetical) order would run them differently. Nested classes are not picked up by surefire on their own.
    static final List<String> SEEN = Collections.synchronizedList(new ArrayList<>());

    interface OrderProbe extends HostContract {
        @Test
        @Order(1)
        default void zulu() {
            SEEN.add("zulu");
        }

        @Test
        @Order(2)
        default void alpha() {
            SEEN.add("alpha");
        }

        @Test
        @Order(Order.DEFAULT + 9000)
        default void bravoLast() {
            SEEN.add("bravoLast");
        }
    }

    static class UnannotatedRun implements OrderProbe {
        @Test
        void ownTestWithoutOrder() {
            SEEN.add("own");
        }

        @Override
        public HostTarget target() {
            return HostTarget.builder("http://127.0.0.1:9").build();
        }
    }

    @TestMethodOrder(MethodOrderer.MethodName.class)
    static class AlphabeticalRun implements OrderProbe {
        @Override
        public HostTarget target() {
            return HostTarget.builder("http://127.0.0.1:9").build();
        }
    }

    interface AbortingProbe extends HostContract {
        @Test
        default void needsAKey() {
            assumeTrue(false, "no key");
        }
    }

    static class AbortingRun implements AbortingProbe {
        @Override
        public HostTarget target() {
            return HostTarget.builder("http://127.0.0.1:9").build();
        }
    }

    private static TestExecutionSummary launch(Class<?> type) {
        LauncherDiscoveryRequest request = LauncherDiscoveryRequestBuilder.request().selectors(selectClass(type))
            .enableImplicitConfigurationParameters(false).build();
        SummaryGeneratingListener listener = new SummaryGeneratingListener();
        LauncherFactory.create().execute(request, listener);
        return listener.getSummary();
    }

    @Test
    void aContractClassRunsByOrderWithoutAnAnnotationOfItsOwnAndFloodComesAfterItsOwnTests() {
        SEEN.clear();
        TestExecutionSummary summary = launch(UnannotatedRun.class);
        assertThat(summary.getTotalFailureCount()).isZero();
        assertThat(SEEN).containsExactly("zulu", "alpha", "own", "bravoLast");
    }

    /** FLD-02 runs right after FLD-01, the numbers the Node kit's catalog gives them. */
    @Test
    void theAddressLimitCaseRunsRightAfterThePerFormFloodCase() throws Exception {
        Order perForm = FloodContract.class.getMethod("askingTooOftenIs429WithRetryAfter").getAnnotation(Order.class);
        Order address = FloodContract.class.getMethod("aBodyThatDoesNotParseIsCountedBeforeTheParse").getAnnotation(Order.class);
        assertThat(perForm.value()).isEqualTo(1073741823 + 9000);
        assertThat(address.value()).isEqualTo(1073741823 + 9001).isEqualTo(Order.DEFAULT + 9001);
    }

    @Test
    void aContractClassThatNamesAnotherOrdererIsRefusedBeforeItsFirstTest() {
        SEEN.clear();
        TestExecutionSummary summary = launch(AlphabeticalRun.class);
        assertThat(SEEN).isEmpty();
        assertThat(summary.getTotalFailureCount()).isEqualTo(1);
        assertThat(summary.getFailures().get(0).getException()).hasMessageContaining("MethodOrderer.OrderAnnotation");
    }

    @Test
    void theExitCodeIsTwoWhenANamedCapabilityAssertedNothing() {
        TestExecutionSummary aborted = launch(AbortingRun.class);
        SEEN.clear();
        TestExecutionSummary passed = launch(UnannotatedRun.class);
        assertThat(new HostTck.Outcome(Map.of(Capability.BUILDER, aborted)).exitCode()).isEqualTo(2);
        assertThat(new HostTck.Outcome(Map.of(Capability.BUILDER, aborted, Capability.FORMS, passed)).unexercised())
            .containsExactly(Capability.BUILDER);
        assertThat(new HostTck.Outcome(Map.of(Capability.FORMS, passed)).exitCode()).isZero();
        assertThat(new HostTck.Outcome(Map.of()).exitCode()).isEqualTo(2);
        assertThat(new HostTck.Outcome(Map.of(Capability.FORMS, launch(AlphabeticalRun.class))).exitCode()).isEqualTo(1);
    }

    @Test
    void theBuilderContractWithoutABuildFormIsAUsageErrorAndNeverTouchesTheHost() {
        // Port 9 (discard) on loopback: a request would fail, not abort, so exit 2 proves nothing was sent.
        HostTarget target = HostTarget.builder("http://127.0.0.1:9").capabilities(EnumSet.of(Capability.BUILDER)).build();
        StringWriter out = new StringWriter();
        HostTck.Outcome outcome = HostTck.run(target, new PrintWriter(out));
        assertThat(outcome.failed()).isZero();
        assertThat(outcome.exitCode()).as(out.toString()).isEqualTo(2);
        assertThat(out.toString()).contains("builder asserted nothing");
    }

    @Test
    void theHardeningResourcesAreInTheJar() {
        String rules = TckFixtures.hardeningRules();
        assertThat(rules).startsWith("({").contains(TckFixtures.LOOP).contains(TckFixtures.MEMORY).contains(TckFixtures.HUGE)
            .contains(TckFixtures.STRAY);
        for (String trigger : new String[] {TckFixtures.LOOP, TckFixtures.MEMORY, TckFixtures.HUGE, TckFixtures.STRAY}) {
            assertThat(trigger.length()).as("fits the fixture's name (maxLength 40)").isLessThanOrEqualTo(40);
        }
        assertThat(getClass().getClassLoader().getResource(TckFixtures.STALE_PROGRAM)).isNotNull();
        assertThat(Capability.of("hardening")).isEqualTo(Capability.HARDENING);
    }

    @Test
    void theHostContextFixtureIsInTheJarWithTheFieldsTheContractReads() {
        tools.jackson.databind.JsonNode form = TckFixtures.hostContextForm();
        assertThat(form.path("id").asString()).isEqualTo(TckFixtures.HOST_CONTEXT_FORM);
        assertThat(form.path("version").asString()).isEqualTo("1");
        tools.jackson.databind.JsonNode content = form.at("/root/children/content");
        assertThat(content.get(0).path("id").asString()).isEqualTo("name");
        assertThat(content.get(1).path("id").asString()).isEqualTo("admin_note");
        assertThat(content.get(1).at("/rules/visibleWhen").asString()).isEqualTo("host.role = \"admin\"");
        assertThat(Capability.of("host-context")).isEqualTo(Capability.HOST_CONTEXT);
    }

    @Test
    void theKitsPdfThemeIsInTheJarWithTheColourThePerRouteTestLooksFor() throws Exception {
        try (java.io.InputStream in = getClass().getClassLoader().getResourceAsStream(TckFixtures.PDF_THEME)) {
            assertThat(in).as(TckFixtures.PDF_THEME).isNotNull();
            tools.jackson.databind.JsonNode theme = TckFixtures.JSON.readTree(in.readAllBytes());
            assertThat(theme.path("id").asString()).isEqualTo(TckFixtures.PDF_THEME_ID);
            assertThat(theme.path("target").asString()).isEqualTo("pdf");
            assertThat(theme.at("/pdf/colors/text").asString()).isEqualTo(TckFixtures.PDF_THEME_TEXT);
        }
    }

    /** A one-page PDF whose content stream (Flate, as the PDF program writes it) sets this fill colour. */
    private static byte[] pdfFilling(String fill) {
        java.util.zip.Deflater deflater = new java.util.zip.Deflater();
        deflater.setInput(("BT /F1 12 Tf " + fill + " rg 72 720 Td (x) Tj ET").getBytes(java.nio.charset.StandardCharsets.ISO_8859_1));
        deflater.finish();
        byte[] buffer = new byte[256];
        int n = deflater.deflate(buffer);
        deflater.end();
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        out.writeBytes("%PDF-1.7\n4 0 obj\n<< /Length ".concat(String.valueOf(n)).concat(" /Filter /FlateDecode >>\nstream\n").getBytes(java.nio.charset.StandardCharsets.ISO_8859_1));
        out.write(buffer, 0, n);
        out.writeBytes("\nendstream\nendobj\n%%EOF\n".getBytes(java.nio.charset.StandardCharsets.ISO_8859_1));
        return out.toByteArray();
    }

    @Test
    void thePdfReaderSeesAFillColourInsideACompressedContentStream() {
        assertThat(PdfColours.setsFillColour(pdfFilling("0.0706 0.2039 0.3373"), TckFixtures.PDF_THEME_TEXT)).isTrue();
        assertThat(PdfColours.setsFillColour(pdfFilling("0.0667 0.0667 0.0667"), TckFixtures.PDF_THEME_TEXT))
            .as("datum-pdf's own text colour is not the kit's").isFalse();
        assertThat(PdfColours.fillColours(pdfFilling(".5 0 1"))).singleElement().satisfies(colour -> assertThat(colour).containsExactly(0.5, 0.0, 1.0));
    }
}
