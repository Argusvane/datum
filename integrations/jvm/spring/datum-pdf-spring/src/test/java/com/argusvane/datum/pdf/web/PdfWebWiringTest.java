package com.argusvane.datum.pdf.web;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

import com.argusvane.datum.sandbox.protocol.ProgramLimits;
import com.argusvane.datum.forms.DefinitionService;
import com.argusvane.datum.forms.datasource.DataSourceOptions;
import com.argusvane.datum.forms.translation.InMemoryTranslationCatalogStore;
import com.argusvane.datum.forms.translation.TranslationCatalogStore;
import com.argusvane.datum.pdf.PdfRuntime;
import com.argusvane.datum.pdf.ScriptedPdfRuntime;
import com.argusvane.datum.pdf.api.PdfApi;
import com.argusvane.datum.pdf.api.PdfDocumentSources;
import com.argusvane.datum.pdf.spring.DatumPdfAutoConfiguration;
import com.argusvane.datum.pdf.web.mvc.CertificateMvcController;
import com.argusvane.datum.pdf.web.mvc.FillMvcController;
import com.argusvane.datum.pdf.web.mvc.PdfMvcController;
import com.argusvane.datum.pdf.web.mvc.SignMvcController;
import com.argusvane.datum.pdf.web.mvc.VerifyMvcController;
import com.argusvane.datum.springweb.spring.DatumProperties;
import com.argusvane.datum.submissions.receiver.SubmissionReceiver;
import com.argusvane.datum.springweb.webflux.DatumRouteRegistry;
import com.argusvane.datum.web.json.DatumJsonMapper;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.runner.ReactiveWebApplicationContextRunner;
import org.springframework.boot.test.context.runner.WebApplicationContextRunner;
import org.springframework.web.reactive.function.server.RouterFunction;

/**
 * The auto-configuration's web wiring over the collaborators of datum-forms and datum-submissions as doubles: the
 * facade and the default document sources exist, the controllers follow their switches, and the WebFlux router
 * registers exactly the enabled routes. (The example's integration test boots the real thing.)
 */
class PdfWebWiringTest {

    /** The properties are constructor-bound, so the context binds them from its environment as the application does. */
    @org.springframework.context.annotation.Configuration(proxyBeanMethods = false)
    @org.springframework.boot.context.properties.EnableConfigurationProperties(DatumProperties.class)
    static class DatumPropertiesConfiguration {
    }


    private WebApplicationContextRunner mvc() {
        return new WebApplicationContextRunner().withConfiguration(AutoConfigurations.of(DatumPdfAutoConfiguration.class))
            .withUserConfiguration(DatumPropertiesConfiguration.class).withBean(DatumRouteRegistry.class, DatumRouteRegistry::new)
            .withBean(com.argusvane.datum.springweb.webflux.DatumMethodRules.class, com.argusvane.datum.springweb.webflux.DatumMethodRules::new)
            .withBean(DatumJsonMapper.class, () -> DatumJsonMapper.create(1 << 20))
            .withBean(PdfRuntime.class, () -> new ScriptedPdfRuntime().pdfRuntime()).withBean(ProgramLimits.class, ProgramLimits::defaults)
            .withBean(SubmissionReceiver.class, () -> mock(SubmissionReceiver.class)).withBean(DefinitionService.class, () -> mock(DefinitionService.class))
            .withBean(TranslationCatalogStore.class, InMemoryTranslationCatalogStore::new)
            .withBean(DataSourceOptions.class, () -> new DataSourceOptions(null, java.time.Duration.ofSeconds(1), null))
            .withPropertyValues(ALL_ROUTES);
    }

    /** Every endpoint is off until switched on; these tests exercise the wiring, so they switch the PDF routes on. */
    private static final String[] ALL_ROUTES = {"datum.web.api.endpoints.pdf=true", "datum.web.api.endpoints.fill=true",
        "datum.web.api.endpoints.sign=true", "datum.web.api.endpoints.verify=true", "datum.web.api.endpoints.certificate=true"};

    @Test
    void theMvcControllersFollowTheirSwitches() {
        mvc().run(context -> {
            assertThat(context).hasSingleBean(PdfApi.class).hasSingleBean(PdfRoutes.class).hasSingleBean(PdfDocumentSources.class);
            assertThat(context.getBean(PdfDocumentSources.class)).isInstanceOf(FormsPdfDocumentSources.class);
            assertThat(context).hasSingleBean(PdfMvcController.class).hasSingleBean(FillMvcController.class).hasSingleBean(SignMvcController.class)
                .hasSingleBean(VerifyMvcController.class).hasSingleBean(CertificateMvcController.class);
        });
        mvc().withPropertyValues("datum.web.api.endpoints.sign=false", "datum.web.api.endpoints.verify=false",
            "datum.web.api.endpoints.certificate=false", "datum.web.api.path=/ops").run(context -> {
                assertThat(context).hasSingleBean(PdfMvcController.class).hasSingleBean(FillMvcController.class);
                assertThat(context).doesNotHaveBean(SignMvcController.class).doesNotHaveBean(VerifyMvcController.class)
                    .doesNotHaveBean(CertificateMvcController.class);
                PdfRoutes routes = context.getBean(PdfRoutes.class);
                assertThat(routes.enabledRoutes()).containsExactly("/ops/pdf", "/ops/pdf/fill");
                assertThat(routes.disabledPaths()).containsExactly("/ops/pdf/sign", "/ops/pdf/verify", "/ops/server/certificate");
            });
    }

    /** The context's own PdfApi over a stubbed receiver and the test signer: who seals a posted answer is the property's call. */
    private WebApplicationContextRunner printing() {
        com.argusvane.datum.forms.DefinitionService definitions = mock(com.argusvane.datum.forms.DefinitionService.class);
        tools.jackson.databind.node.ObjectNode definition = (tools.jackson.databind.node.ObjectNode) com.argusvane.datum.pdf.TestAssets.JSON
            .readTree(PdfWebTestBeans.DEFINITION);
        org.mockito.Mockito.when(definitions.current("intake")).thenReturn(new com.argusvane.datum.forms.CurrentDefinition(definition, "sha"));
        SubmissionReceiver receiver = mock(SubmissionReceiver.class);
        tools.jackson.databind.node.ObjectNode report = (tools.jackson.databind.node.ObjectNode) com.argusvane.datum.pdf.TestAssets.JSON
            .readTree("{\"outcome\":\"accepted\",\"values\":{\"name\":\"x\"}}");
        org.mockito.Mockito.when(receiver.receive(org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any()))
            .thenReturn(new com.argusvane.datum.submissions.receiver.ReceiverAnswer(200, report));
        return new WebApplicationContextRunner().withConfiguration(AutoConfigurations.of(DatumPdfAutoConfiguration.class))
            .withUserConfiguration(DatumPropertiesConfiguration.class).withBean(DatumRouteRegistry.class, DatumRouteRegistry::new)
            .withBean(com.argusvane.datum.springweb.webflux.DatumMethodRules.class, com.argusvane.datum.springweb.webflux.DatumMethodRules::new)
            .withBean(DatumJsonMapper.class, () -> DatumJsonMapper.create(1 << 20))
            .withBean(PdfRuntime.class, () -> new ScriptedPdfRuntime().pdfRuntime()).withBean(ProgramLimits.class, ProgramLimits::defaults)
            .withBean(SubmissionReceiver.class, () -> receiver).withBean(DefinitionService.class, () -> definitions)
            .withBean(com.argusvane.datum.pdf.PdfSigner.class, () -> com.argusvane.datum.pdf.TestAssets.signer("chain-leaf"))
            .withBean(PdfDocumentSources.class, () -> new PdfDocumentSources() {
            })
            .withPropertyValues("datum.pdf.seal.enabled=true");
    }

    private static String signedBy(org.springframework.context.ApplicationContext context) {
        String body = "{\"document\":" + PdfWebTestBeans.ENVELOPE + "}";
        var request = new com.argusvane.datum.submissions.spi.SubmissionRequest("application/json", java.util.Map.of(), "192.0.2.7", null);
        return context.getBean(PdfApi.class).pdf(body.getBytes(java.nio.charset.StandardCharsets.UTF_8), request).headers().get("X-Signed-By");
    }

    @Test
    void postedAnswersAreSealedWithTheServersKeyOnlyWhenThePropertySaysSo() {
        printing().run(context -> assertThat(signedBy(context)).as("default: a throwaway test certificate").contains("Datum test seal"));
        printing().withPropertyValues("datum.pdf.seal.posted-answers=true")
            .run(context -> assertThat(signedBy(context)).as("opted in: the server's own certificate").contains("Datum forms office"));
    }

    @Test
    void theHostsBindingsReachThePdfServiceAndAReplyNamesThePdfThemeOfTheFormsBinding() {
        com.argusvane.datum.core.assets.AssetManifest manifest = new com.argusvane.datum.core.assets.AssetManifest("b1", null, "0.1.0", null,
            null, null, java.util.List.of(new com.argusvane.datum.core.assets.AssetManifest.Binding("datum", "Datum", "datum-pdf")), null, null, null, null);
        tools.jackson.databind.JsonNode ledger = com.argusvane.datum.pdf.TestAssets.JSON
            .readTree("{\"id\":\"ledger\",\"version\":\"1.0.0\",\"target\":\"pdf\"}");
        com.argusvane.datum.core.assets.HostBindings bindings = com.argusvane.datum.core.assets.HostBindings.of(manifest, "datum",
            java.util.Map.of("intake", "ledger-binding"),
            java.util.List.of(new com.argusvane.datum.core.assets.AssetManifest.Binding("ledger-binding", "Ledger", "ledger")), java.util.Map.of("ledger", ledger));
        printing().withBean(com.argusvane.datum.core.assets.HostBindings.class, () -> bindings).run(context -> {
            assertThat(context.getBean(com.argusvane.datum.pdf.PdfService.class).pdfThemeId("intake")).isEqualTo("ledger");
            String body = "{\"document\":" + PdfWebTestBeans.ENVELOPE + "}";
            var request = new com.argusvane.datum.submissions.spi.SubmissionRequest("application/json", java.util.Map.of(), "192.0.2.7", null);
            assertThat(context.getBean(PdfApi.class).pdf(body.getBytes(java.nio.charset.StandardCharsets.UTF_8), request).headers())
                .containsEntry("X-Datum-Pdf-Theme", "ledger");
        });
        printing().run(context -> assertThat(context.getBean(com.argusvane.datum.pdf.PdfService.class).pdfThemeId("intake")).isNull());
    }

    @Test
    void anApplicationDocumentSourcesBeanWins() {
        PdfDocumentSources mine = new PdfDocumentSources() {
        };
        mvc().withBean(PdfDocumentSources.class, () -> mine).run(context -> assertThat(context.getBean(PdfDocumentSources.class)).isSameAs(mine));
    }

    @Test
    void theReactiveRouterRegistersExactlyTheEnabledRoutes() {
        new ReactiveWebApplicationContextRunner().withConfiguration(AutoConfigurations.of(DatumPdfAutoConfiguration.class))
            .withUserConfiguration(DatumPropertiesConfiguration.class).withBean(DatumRouteRegistry.class, DatumRouteRegistry::new)
            .withBean(com.argusvane.datum.springweb.webflux.DatumMethodRules.class, com.argusvane.datum.springweb.webflux.DatumMethodRules::new)
            .withBean(DatumJsonMapper.class, () -> DatumJsonMapper.create(1 << 20))
            .withBean(PdfRuntime.class, () -> new ScriptedPdfRuntime().pdfRuntime()).withBean(ProgramLimits.class, ProgramLimits::defaults)
            .withBean(SubmissionReceiver.class, () -> mock(SubmissionReceiver.class)).withBean(DefinitionService.class, () -> mock(DefinitionService.class))
            .withBean(TranslationCatalogStore.class, InMemoryTranslationCatalogStore::new)
            .withBean(DataSourceOptions.class, () -> new DataSourceOptions(null, java.time.Duration.ofSeconds(1), null))
            .withPropertyValues(ALL_ROUTES).withPropertyValues("datum.web.api.endpoints.sign=false").run(context -> {
                assertThat(context).hasBean("datumPdfRouterFunction");
                assertThat(context.getBean("datumPdfRouterFunction")).isInstanceOf(RouterFunction.class);
                DatumRouteRegistry registry = context.getBean(DatumRouteRegistry.class);
                assertThat(registry.matches("/api/pdf")).isTrue();
                assertThat(registry.matches("/api/pdf/fill")).isTrue();
                assertThat(registry.matches("/api/pdf/verify")).isTrue();
                assertThat(registry.matches("/api/server/certificate")).isTrue();
                assertThat(registry.matches("/api/pdf/sign")).as("a switched-off route is not Datum's").isFalse();
                // A wrong method answers 405 from the shared method rules (DatumMethodNotAllowedMapping), not from a
                // path-wide route of this router.
                com.argusvane.datum.springweb.webflux.DatumMethodRules methods = context.getBean(com.argusvane.datum.springweb.webflux.DatumMethodRules.class);
                assertThat(methods.allowed("/api/pdf")).containsExactly("POST");
                assertThat(methods.allowed("/api/server/certificate")).containsExactly("GET", "HEAD");
                assertThat(methods.allowed("/api/pdf/sign")).as("a switched-off route has no rule").isEmpty();
            });
    }
}
