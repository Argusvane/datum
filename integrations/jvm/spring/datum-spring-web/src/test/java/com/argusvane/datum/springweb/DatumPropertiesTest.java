package com.argusvane.datum.springweb;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.springweb.spring.DatumProperties;
import com.argusvane.datum.web.WebSettings;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.boot.context.properties.source.MapConfigurationPropertySource;
import org.springframework.util.unit.DataSize;

class DatumPropertiesTest {

    @Test
    void defaultsAreThePlansDefaults() {
        DatumProperties p = DatumProperties.defaults();
        assertThat(p.enabled()).isTrue();
        DatumProperties.Web.Api api = p.web().api();
        assertThat(api.path()).isEqualTo("/api");
        assertThat(api.maxBodySize()).isEqualTo(DataSize.ofMegabytes(1));
        assertThat(api.problemDetails()).isFalse();
        // Every endpoint is off until the application switches it on.
        for (String off : List.of("submissions", "validate", "definition", "data-sources", "pdf", "fill", "sign", "verify", "certificate",
            "inspect", "test")) {
            assertThat(api.endpointEnabled(off)).as(off).isFalse();
        }
        DatumProperties.Web.Assets assets = p.web().assets();
        assertThat(assets.enabled()).as("the asset routes are endpoints: off by default").isFalse();
        assertThat(assets.path()).isEqualTo("/datum/assets");
        assertThat(assets.cachePeriod()).isEqualTo(Duration.ofDays(365));
        assertThat(p.web().csrf().headerName()).isEqualTo("X-XSRF-TOKEN");
        assertThat(p.web().csrf().cookieName()).isEqualTo("XSRF-TOKEN");
        assertThat(p.web().csrf().metaName()).isEqualTo("_csrf");
        assertThat(p.web().throttle().limit()).isEqualTo(60);
        assertThat(p.web().throttle().window()).isEqualTo(Duration.ofMinutes(1));
        assertThat(p.web().throttle().by()).containsExactly("ip", "form");
        assertThat(p.web().throttle().addressLimit()).as("ten times the per-form limit").isEqualTo(600);
        assertThat(p.web().openapi().enabled()).isTrue();
        assertThat(p.web().openapi().groupPrefix()).isEqualTo("datum-");
    }

    /** Binding nothing builds the same object as {@link DatumProperties#defaults()}: the annotations and the constants agree. */
    @Test
    void bindingNothingGivesTheDefaults() {
        DatumProperties bound = new Binder(new MapConfigurationPropertySource(Map.of())).bindOrCreate("datum", DatumProperties.class);
        assertThat(bound).isEqualTo(DatumProperties.defaults());
        assertThat(bound.toSettings()).isEqualTo(WebSettings.defaults());
    }

    @Test
    void bindsFromRelaxedPropertyNames() {
        Binder binder = new Binder(new MapConfigurationPropertySource(Map.ofEntries(
            Map.entry("datum.enabled", "false"),
            Map.entry("datum.web.api.path", "datum-api/"),
            Map.entry("datum.web.api.max-body-size", "2MB"),
            Map.entry("datum.web.api.problem-details", "true"),
            Map.entry("datum.web.api.endpoints.inspect", "true"),
            Map.entry("datum.web.api.endpoints.data-sources", "false"),
            Map.entry("datum.web.assets.path", "/static/datum/"),
            Map.entry("datum.web.assets.cache-period", "1h"),
            Map.entry("datum.web.assets.omit-features", "pdf,journeys"),
            Map.entry("datum.web.throttle.window", "30s"),
            Map.entry("datum.web.openapi.group-prefix", "acme-"))));
        DatumProperties p = binder.bind("datum", DatumProperties.class).get();
        assertThat(p.enabled()).isFalse();
        assertThat(p.web().api().path()).isEqualTo("/datum-api");
        assertThat(p.web().api().maxBodySize()).isEqualTo(DataSize.ofMegabytes(2));
        assertThat(p.web().api().problemDetails()).isTrue();
        assertThat(p.web().api().endpointEnabled("inspect")).isTrue();
        assertThat(p.web().api().endpointEnabled("data-sources")).isFalse();
        assertThat(p.web().assets().path()).isEqualTo("/static/datum");
        assertThat(p.web().assets().cachePeriod()).isEqualTo(Duration.ofHours(1));
        assertThat(p.web().assets().omitFeatures()).containsExactly("pdf", "journeys");
        assertThat(p.web().throttle().window()).isEqualTo(Duration.ofSeconds(30));
        assertThat(p.web().openapi().groupPrefix()).isEqualTo("acme-");
        // What was not set keeps its default.
        assertThat(p.web().csrf().headerName()).isEqualTo("X-XSRF-TOKEN");
        assertThat(p.web().throttle().limit()).isEqualTo(60);
    }

    @Test
    void theAddressLimitBindsAWholeNumberAndZeroTurnsItOff() {
        DatumProperties set = new Binder(new MapConfigurationPropertySource(Map.of("datum.web.throttle.address-limit", "200")))
            .bindOrCreate("datum", DatumProperties.class);
        assertThat(set.web().throttle().addressLimit()).isEqualTo(200);
        DatumProperties off = new Binder(new MapConfigurationPropertySource(Map.of("datum.web.throttle.address-limit", "0")))
            .bindOrCreate("datum", DatumProperties.class);
        assertThat(off.web().throttle().addressLimit()).as("0 keeps no address limit").isZero();
        assertThat(DatumProperties.Web.Throttle.DEFAULT_ADDRESS_LIMIT).isEqualTo(600);
        // Binding-level, like limits and max-keys: the shared settings do not carry it.
        assertThat(set.toSettings().throttle()).isEqualTo(WebSettings.defaults().throttle());
    }

    @Test
    void theAddressLimitIsInTheConfigurationMetadataWithItsDefault() throws Exception {
        try (java.io.InputStream in = getClass().getClassLoader().getResourceAsStream("META-INF/spring-configuration-metadata.json")) {
            assertThat(in).isNotNull();
            tools.jackson.databind.JsonNode metadata = new tools.jackson.databind.json.JsonMapper().readTree(in);
            tools.jackson.databind.JsonNode entry = null;
            for (tools.jackson.databind.JsonNode property : metadata.path("properties")) {
                if (property.path("name").asString().equals("datum.web.throttle.address-limit")) {
                    entry = property;
                }
            }
            assertThat(entry).as("datum.web.throttle.address-limit").isNotNull();
            assertThat(entry.path("defaultValue").asInt()).isEqualTo(600);
            assertThat(entry.path("description").asString()).contains("before the body is read").contains("0 to keep no address limit");
        }
    }

    /** The defaults (kept for the configuration metadata) are the library's. */
    @Test
    void theDefaultsAreTheSettingsDefaults() {
        assertThat(DatumProperties.defaults().toSettings()).isEqualTo(WebSettings.defaults());
        DatumProperties set = new Binder(new MapConfigurationPropertySource(Map.of("datum.web.api.path", "x/",
            "datum.web.api.endpoints.test", "true", "datum.web.assets.path", "/static/datum/"))).bindOrCreate("datum", DatumProperties.class);
        WebSettings settings = set.toSettings();
        assertThat(settings.api().path()).isEqualTo("/x");
        assertThat(settings.api().endpointEnabled("test")).isTrue();
        assertThat(settings.api().endpointEnabled("inspect")).isFalse();
        assertThat(settings.api().endpointEnabled("submissions")).as("not set is off").isFalse();
        assertThat(settings.assets().path()).isEqualTo("/static/datum");
    }
}
