package com.argusvane.datum.web.assets;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.core.assets.AssetManifestLoader;
import com.argusvane.datum.web.WebSettings;
import com.argusvane.datum.web.monitoring.DatumCapabilities;
import com.argusvane.datum.web.monitoring.DatumCapability;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * The asset service over the settings record alone, as any host binding builds it (so a build of this library proves its own logic; the Spring binding keeps a test that
 * its properties reach these settings). The fixtures under src/test/resources are datum-spring-web's, copied.
 */
class AssetServiceTest {

    private static final JsonMapper JSON = JsonMapper.builder().build();

    private AssetService service(WebSettings settings, WithheldAssets... withheld) {
        DatumAssets assets = new DatumAssets(true, "testbuild1", "/datum/assets", "/datum/assets/testbuild1", "/api",
            AssetManifestLoader.load(getClass().getClassLoader()));
        return new AssetService(assets, settings, List.of(withheld), getClass().getClassLoader(), JSON);
    }

    private static WebSettings withAssets(WebSettings.Assets assets) {
        WebSettings d = WebSettings.defaults();
        return new WebSettings(d.enabled(), d.api(), assets, d.csrf(), d.throttle(), d.openapi());
    }

    @Test
    void theGateLetsThroughTheMatchingBuildOnlyAndAnswersTheFilePath() {
        AssetService service = service(WebSettings.defaults());
        assertThat(service.gate("testbuild1/datum-form.js")).contains("datum-form.js");
        assertThat(service.gate("testbuild1/sub/data.json")).contains("sub/data.json");
        // The gate decides what may be asked for; whether the file exists is the framework's resource handler's answer (404).
        assertThat(service.gate("testbuild1/missing.js")).contains("missing.js");
        assertThat(service.gate("otherbuild/datum-form.js")).isEmpty();
        assertThat(service.gate("testbuild1")).isEmpty();
        assertThat(service.gate("/datum-form.js")).as("an empty build id").isEmpty();
        assertThat(service.gate("testbuild1/")).isEmpty();
        assertThat(service.gate("testbuild1/sub/")).isEmpty();
        assertThat(service.gate(null)).isEmpty();
        AssetService off = new AssetService(new DatumAssets(false, "testbuild1", "/datum/assets", "/datum/assets/testbuild1", "/api",
            AssetManifestLoader.load(getClass().getClassLoader())), WebSettings.defaults(), List.of(), getClass().getClassLoader(), JSON);
        assertThat(off.gate("testbuild1/datum-form.js")).as("assets off").isEmpty();
    }

    @Test
    void refusesPathsThatClimbOrHideAnEscape() {
        AssetService service = service(WebSettings.defaults());
        for (String path : new String[] {"../manifest.json", "sub/../../manifest.json", "%2e%2e/manifest.json", "%2E%2e/manifest.json",
            "sub%2fdata.json", "sub%2Fdata.json", "sub\\data.json", "/../manifest.json", "a//b", "./datum-form.js", "sub/./data.json",
            "datum-form.js\0", "c:/x", "", "/datum-form.js", "datum-form.js;v=1", "datum-form.js;", "sub;x/data.json", "datum-form.js?x",
            "datum-form.js#x", "datum-form.\u00e9js", "datum-form.js\u212a", "datum-form.\u017fs", " datum-form.js", "datum-form.js\n", "datum-form.js.", "sub./data.json", "pdfjs/pdf.worker.min.mjs."}) {
            assertThat(service.gate("testbuild1/" + path)).as(path).isEmpty();
        }
        assertThat(service.gate("testbuild1;x=y/datum-form.js")).as("path parameters on the build id").isEmpty();
        assertThat(service.gate("testbuild1%2fdatum-form.js")).isEmpty();
    }

    @Test
    void theRefusalIsABareNoStore404() {
        AssetReply reply = service(WebSettings.defaults()).notFoundReply();
        assertThat(reply.status()).isEqualTo(404);
        assertThat(reply.headers()).containsExactly(java.util.Map.entry("Cache-Control", "no-store"));
        assertThat(reply.body()).isEmpty();
    }

    @Test
    void withheldAndOmittedFilesAreNotFoundInAnyCase() {
        WebSettings.Assets d = WebSettings.Assets.defaults();
        WebSettings settings = withAssets(new WebSettings.Assets(d.enabled(), d.path(), d.cachePeriod(),
            List.of("journeys", "signing", "unknown-token")));
        AssetService service = service(settings, path -> path.equals("datum-builder.js"));
        assertThat(service.gate("testbuild1/datum-builder.js")).isEmpty();
        assertThat(service.gate("testbuild1/datum-journey-chunk.js")).isEmpty();
        // signing is an alias of webauthn in feature-files.json
        assertThat(service.gate("testbuild1/datum-webauthn-chunk.js")).isEmpty();
        assertThat(service.gate("testbuild1/datum-form.js")).isPresent();
        // A file system that ignores case would resolve these to the withheld files: both lists compare lower-cased too.
        for (String spelling : new String[] {"DATUM-BUILDER.JS", "Datum-Builder.js", "datum-builder.JS", "DATUM-JOURNEY-CHUNK.JS",
            "Datum-WebAuthn-Chunk.Js"}) {
            assertThat(service.gate("testbuild1/" + spelling)).as(spelling).isEmpty();
        }
    }

    @Test
    void hostJsonNamesTheBuildAndTheCsrfNames() {
        WebSettings d = WebSettings.defaults();
        WebSettings settings = new WebSettings(d.enabled(), d.api(), d.assets(),
            new WebSettings.Csrf("X-CSRF", WebSettings.Csrf.DEFAULT_COOKIE, WebSettings.Csrf.DEFAULT_META), d.throttle(), d.openapi());
        JsonNode host = JSON.readTree(service(settings).hostJson());
        assertThat(host.get("buildId").asString()).isEqualTo("testbuild1");
        assertThat(host.get("assetsBase").asString()).isEqualTo("/datum/assets/testbuild1");
        assertThat(host.get("apiBase").asString()).isEqualTo("/api");
        assertThat(host.get("csrf").get("headerName").asString()).isEqualTo("X-CSRF");
        assertThat(host.get("csrf").get("cookieName").asString()).isEqualTo("XSRF-TOKEN");
        assertThat(host.get("csrf").get("metaName").asString()).isEqualTo("_csrf");
    }

    /** host.json names the endpoint bases the capabilities registered, with the context path in front. */
    @Test
    void hostJsonCarriesTheEndpointPathsCapabilitiesRegistered() {
        assertThat(JSON.readTree(withCapabilities("/api", DatumCapabilities.of()).hostJson()).has("paths")).as("none registered").isFalse();

        DatumCapabilities capabilities = DatumCapabilities.of(DatumCapability.of("webauthn").withEndpoint("webauthn", "/api/passkeys"),
            DatumCapability.of("timestamp").withEndpoint("tsa", "/tsa"));
        JsonNode plain = JSON.readTree(withCapabilities("/api", capabilities).hostJson());
        assertThat(plain.get("paths").get("webauthn").asString()).isEqualTo("/api/passkeys");
        assertThat(plain.get("paths").get("tsa").asString()).isEqualTo("/tsa");

        JsonNode mounted = JSON.readTree(withCapabilities("/shop/api", capabilities).hostJson());
        assertThat(mounted.get("paths").get("webauthn").asString()).isEqualTo("/shop/api/passkeys");
        assertThat(mounted.get("paths").get("tsa").asString()).isEqualTo("/shop/tsa");
    }

    /** host.json publishes the bindings table the page glue reads: the default, the per-route overrides and the catalog. */
    @Test
    void hostJsonCarriesTheBindingsAHostConfigured() {
        assertThat(JSON.readTree(service(WebSettings.defaults()).hostJson()).has("bindings")).as("a host that configures none").isFalse();

        com.argusvane.datum.core.assets.AssetManifest manifest = new com.argusvane.datum.core.assets.AssetManifest("testbuild1", null, "0.1.0",
            null, null, null, List.of(new com.argusvane.datum.core.assets.AssetManifest.Binding("datum", "Datum", "datum-pdf")), null, null, null, null);
        JsonNode ledger = JSON.readTree("{\"id\":\"ledger\",\"version\":\"1.0.0\",\"target\":\"pdf\"}");
        com.argusvane.datum.core.assets.HostBindings bindings = com.argusvane.datum.core.assets.HostBindings.of(manifest, "datum",
            java.util.Map.of("benefits", "ledger-binding"),
            List.of(new com.argusvane.datum.core.assets.AssetManifest.Binding("ledger-binding", "Ledger", "ledger")), java.util.Map.of("ledger", ledger));
        DatumAssets assets = new DatumAssets(true, "testbuild1", "/datum/assets", "/datum/assets/testbuild1", "/api", manifest);
        JsonNode host = JSON.readTree(new AssetService(assets, WebSettings.defaults(), List.of(), getClass().getClassLoader(), JSON, null, bindings).hostJson());
        assertThat(host.get("bindings").get("default").asString()).isEqualTo("datum");
        assertThat(host.get("bindings").get("routes").get("benefits").asString()).isEqualTo("ledger-binding");
        assertThat(host.get("bindings").get("catalog").get(1).get("pdfTheme").asString()).isEqualTo("ledger");
    }

    private AssetService withCapabilities(String apiBase, DatumCapabilities capabilities) {
        DatumAssets assets = new DatumAssets(true, "testbuild1", "/shop/datum/assets", "/shop/datum/assets/testbuild1", apiBase,
            AssetManifestLoader.load(getClass().getClassLoader()));
        return new AssetService(assets, WebSettings.defaults(), List.of(), getClass().getClassLoader(), JSON, capabilities);
    }

    @Test
    void theGlueScriptIsShippedWithTheModule() {
        String glue = new String(service(WebSettings.defaults()).glue(), StandardCharsets.UTF_8);
        assertThat(glue).contains("DatumHost").contains("datum-submit").contains("/submissions");
    }

    @Test
    void cacheControlFollowsTheCachePeriod() {
        assertThat(service(WebSettings.defaults()).cachePeriod()).isEqualTo(Duration.ofDays(365));
        WebSettings.Assets d = WebSettings.Assets.defaults();
        WebSettings fiveMinutes = withAssets(new WebSettings.Assets(d.enabled(), d.path(), Duration.ofMinutes(5), d.omitFeatures()));
        assertThat(service(fiveMinutes).cachePeriod()).isEqualTo(Duration.ofMinutes(5));
    }

    /** The documents the bindings write out unchanged: status, headers and bytes. */
    @Test
    void theDocumentsCarryTheStatusAndTheCacheHeaders() {
        AssetService service = service(WebSettings.defaults());
        AssetReply host = service.hostJsonReply();
        assertThat(host.status()).isEqualTo(200);
        assertThat(host.headers()).containsEntry("Content-Type", "application/json").containsEntry("Cache-Control", "no-store");
        assertThat(host.body()).isEqualTo(service.hostJson());
        AssetReply glue = service.glueReply();
        assertThat(glue.headers()).containsEntry("Content-Type", "text/javascript;charset=UTF-8").containsEntry("Cache-Control", "no-cache");
        assertThat(glue.body()).isEqualTo(service.glue());
    }
}
