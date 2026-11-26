package com.argusvane.datum.web.assets;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.core.assets.AssetManifestLoader;
import com.argusvane.datum.springweb.spring.DatumProperties;
import java.util.List;
import java.util.Map;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.boot.context.properties.source.MapConfigurationPropertySource;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * The Spring half of the asset service's tests: {@code datum.web.*} properties reach the service through
 * {@link DatumProperties#toSettings()}. The service's own logic (paths, builds, withheld files, host.json, the glue)
 * is tested over the settings record in datum-web-core's AssetServiceTest; the media types are
 * Spring's own (the resource handler names them; the ui binding's asset contract tests hold them).
 */
class AssetServicePropertiesTest {

    private static final JsonMapper JSON = JsonMapper.builder().build();

    private static DatumProperties bound(Map<String, String> properties) {
        return new Binder(new MapConfigurationPropertySource(properties)).bindOrCreate("datum", DatumProperties.class);
    }

    private AssetService service(DatumProperties properties, WithheldAssets... withheld) {
        DatumAssets assets = new DatumAssets(true, "testbuild1", "/datum/assets", "/datum/assets/testbuild1", "/api",
            AssetManifestLoader.load(getClass().getClassLoader()));
        return new AssetService(assets, properties.toSettings(), List.of(withheld), getClass().getClassLoader(), JSON);
    }

    @Test
    void omitFeaturesFromThePropertiesHideTheirFiles() {
        DatumProperties properties = bound(Map.of("datum.web.assets.omit-features", "journeys,signing,unknown-token"));
        AssetService service = service(properties, path -> path.equals("datum-builder.js"));
        assertThat(service.gate("testbuild1/datum-builder.js")).isEmpty();
        assertThat(service.gate("testbuild1/datum-journey-chunk.js")).isEmpty();
        // signing is an alias of webauthn in feature-files.json
        assertThat(service.gate("testbuild1/datum-webauthn-chunk.js")).isEmpty();
        assertThat(service.gate("testbuild1/datum-form.js")).isPresent();
    }

    @Test
    void theCsrfPropertiesReachHostJson() {
        DatumProperties properties = bound(Map.of("datum.web.csrf.header-name", "X-CSRF"));
        JsonNode host = JSON.readTree(service(properties).hostJson());
        assertThat(host.get("csrf").get("headerName").asString()).isEqualTo("X-CSRF");
        assertThat(host.get("csrf").get("cookieName").asString()).isEqualTo("XSRF-TOKEN");
        assertThat(host.get("csrf").get("metaName").asString()).isEqualTo("_csrf");
    }

    @Test
    void theCachePeriodPropertyReachesCacheControl() {
        assertThat(service(DatumProperties.defaults()).cachePeriod()).isEqualTo(java.time.Duration.ofSeconds(31536000));
        DatumProperties short5 = bound(Map.of("datum.web.assets.cache-period", "5m"));
        assertThat(service(short5).cachePeriod()).isEqualTo(java.time.Duration.ofSeconds(300));
    }
}
