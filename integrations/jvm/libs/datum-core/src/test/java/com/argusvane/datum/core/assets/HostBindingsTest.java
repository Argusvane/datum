package com.argusvane.datum.core.assets;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.core.DatumConfigurationException;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

class HostBindingsTest {

    private static final JsonMapper JSON = JsonMapper.builder().build();

    private static final AssetManifest MANIFEST = new AssetManifest("b1", null, "0.1.0", null, null, null,
        List.of(new AssetManifest.Binding("datum", "Datum", "datum-pdf")),
        null, null, null, null);

    private static JsonNode theme(String id, String target) {
        return JSON.readTree("{\"id\":\"" + id + "\",\"version\":\"1.0.0\",\"target\":\"" + target + "\"}");
    }

    private static final List<AssetManifest.Binding> GCDS = List.of(new AssetManifest.Binding("gcds", "GC Design System", "gcds"));

    @Test
    void aHostThatConfiguredNothingDrawsEveryRouteWithDatumUnderTheEnginesPdfTheme() {
        HostBindings bindings = HostBindings.of(MANIFEST);
        assertThat(bindings.defaultBinding()).isEqualTo("datum");
        assertThat(bindings.bindingOf("contact")).isEqualTo("datum");
        assertThat(bindings.pdfThemeId("contact")).isEqualTo("datum-pdf");
        assertThat(bindings.pdfTheme("contact")).as("the engine's own look needs no theme object").isNull();
    }

    @Test
    void aClasspathWithoutAManifestStillHasTheDatumBinding() {
        HostBindings bindings = HostBindings.of(AssetManifest.absent());
        assertThat(bindings.pdfThemeId("anything")).isEqualTo("datum-pdf");
    }

    @Test
    void twoRoutesOnOneHostGetEachRoutesCatalogPdfTheme() {
        JsonNode gcds = theme("gcds", "pdf");
        HostBindings bindings = HostBindings.of(MANIFEST, "datum", Map.of("benefits", "gcds"), GCDS, Map.of("gcds", gcds));
        assertThat(bindings.bindingOf("benefits")).isEqualTo("gcds");
        assertThat(bindings.pdfThemeId("benefits")).isEqualTo("gcds");
        assertThat(bindings.pdfTheme("benefits")).isEqualTo(gcds);
        assertThat(bindings.bindingOf("contact")).isEqualTo("datum");
        assertThat(bindings.pdfThemeId("contact")).isEqualTo("datum-pdf");
        assertThat(bindings.pdfTheme("contact")).isNull();
    }

    @Test
    void theDefaultBindingIsWhatAnUnlistedRouteIsDrawnBy() {
        HostBindings bindings = HostBindings.of(MANIFEST, "gcds", Map.of("contact", "datum"), GCDS, Map.of("gcds", theme("gcds", "pdf")));
        assertThat(bindings.pdfThemeId("anything")).isEqualTo("gcds");
        assertThat(bindings.pdfThemeId("contact")).isEqualTo("datum-pdf");
        assertThat(bindings.pdfThemeId(null)).isEqualTo("gcds");
    }

    @Test
    void aBindingWithoutAPdfThemeSuggestsNone() {
        HostBindings bindings = HostBindings.of(MANIFEST, "plain", Map.of(), List.of(new AssetManifest.Binding("plain", null, null)), Map.of());
        assertThat(bindings.pdfThemeId("x")).isNull();
        assertThat(bindings.pdfTheme("x")).isNull();
        assertThat(bindings.catalog().get("plain").label()).as("the id when no label").isEqualTo("plain");
    }

    @Test
    void aBindingTheCatalogDoesNotListStopsStartup() {
        assertThatThrownBy(() -> HostBindings.of(MANIFEST, "nope", Map.of(), List.of(), Map.of()))
            .isInstanceOf(DatumConfigurationException.class).hasMessageContaining("'nope'")
            .extracting(e -> ((DatumConfigurationException) e).property()).isEqualTo("datum.bindings.default");
        assertThatThrownBy(() -> HostBindings.of(MANIFEST, null, Map.of("contact", "nope"), List.of(), Map.of()))
            .isInstanceOf(DatumConfigurationException.class)
            .extracting(e -> ((DatumConfigurationException) e).property()).isEqualTo("datum.bindings.routes.contact");
    }

    @Test
    void aSuggestedPdfThemeNobodySuppliesStopsStartup() {
        assertThatThrownBy(() -> HostBindings.of(MANIFEST, "gcds", Map.of(), GCDS, Map.of()))
            .isInstanceOf(DatumConfigurationException.class).hasMessageContaining("'gcds'")
            .extracting(e -> ((DatumConfigurationException) e).property()).isEqualTo("datum.bindings.pdf-themes.gcds");
    }

    @Test
    void aSuppliedPdfThemeIsAPdfThemeUnderItsOwnId() {
        assertThatThrownBy(() -> HostBindings.of(MANIFEST, "gcds", Map.of(), GCDS, Map.of("gcds", theme("gcds", "form"))))
            .isInstanceOf(DatumConfigurationException.class).hasMessageContaining("not a PDF theme");
        assertThatThrownBy(() -> HostBindings.of(MANIFEST, "gcds", Map.of(), GCDS, Map.of("gcds", theme("other", "pdf"))))
            .isInstanceOf(DatumConfigurationException.class).hasMessageContaining("one name");
    }

    @Test
    void datumDarkIsNoBindingAndStopsStartup() {
        // Dark is the element's scheme attribute: the bundles' catalog lists Datum alone, so no host can name a binding no page draws.
        assertThatThrownBy(() -> HostBindings.of(MANIFEST, "datum-dark", Map.of(), List.of(), Map.of()))
            .isInstanceOf(DatumConfigurationException.class).hasMessageContaining("'datum-dark'");
    }

    @Test
    void aRouteIsAnyFormKeyTheStoreAccepts() {
        String longest = "k".repeat(128);
        HostBindings bindings = HostBindings.of(MANIFEST, null, Map.of("_intake", "gcds", longest, "datum"), GCDS, Map.of("gcds", theme("gcds", "pdf")));
        assertThat(bindings.bindingOf("_intake")).isEqualTo("gcds");
        assertThat(bindings.bindingOf(longest)).isEqualTo("datum");
        for (String key : List.of("k".repeat(129), "a@1", "")) {
            assertThatThrownBy(() -> HostBindings.of(MANIFEST, null, Map.of(key, "datum"), List.of(), Map.of()))
                .isInstanceOf(DatumConfigurationException.class).hasMessageContaining("is not a form key");
        }
    }

    @Test
    void aFormKeyAndAnIdAreNamesNotPaths() {
        assertThatThrownBy(() -> HostBindings.of(MANIFEST, null, Map.of("../x", "datum"), List.of(), Map.of()))
            .isInstanceOf(DatumConfigurationException.class);
        assertThatThrownBy(() -> HostBindings.of(MANIFEST, null, Map.of(), List.of(new AssetManifest.Binding("a b", "x", null)), Map.of()))
            .isInstanceOf(DatumConfigurationException.class);
    }

    @Test
    void hostJsonDescribesTheDefaultTheOverridesAndTheCatalog() {
        HostBindings bindings = HostBindings.of(MANIFEST, "datum", Map.of("benefits", "gcds"), GCDS, Map.of("gcds", theme("gcds", "pdf")));
        Map<String, Object> described = bindings.describe();
        assertThat(described).containsEntry("default", "datum").containsEntry("routes", Map.of("benefits", "gcds"));
        assertThat(JSON.writeValueAsString(described)).contains("{\"id\":\"datum\",\"label\":\"Datum\",\"pdfTheme\":\"datum-pdf\"}",
            "{\"id\":\"gcds\",\"label\":\"GC Design System\",\"pdfTheme\":\"gcds\"}");
    }
}
