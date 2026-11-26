package com.argusvane.datum.tck;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;

/**
 * Story two's browser half: {@code host.json} names the versioned assets base and the API base, the form's bundles
 * are served immutable under the build id, the page glue is served, and the builder's files stay away unless the
 * builder is on ({@link HostTarget#builderEnabled()}), by no other spelling either. Moved here from the Spring ui and
 * webflux-pdf examples and datum-ui's asset contract.
 */
public interface AssetsContract extends HostContract {

    private JsonNode host() {
        Reply host = http().get(target().assetsPath() + "/host.json");
        assertThat(host.status()).as(host.toString()).isEqualTo(200);
        assertThat(host.mediaType()).endsWith("json");
        return host.json();
    }

    private String assetsBase() {
        return host().path("assetsBase").asString();
    }

    @Test
    @Order(1301)
    default void hostJsonNamesTheBuildTheAssetsAndTheApi() {
        JsonNode host = host();
        String buildId = host.path("buildId").asString();
        assertThat(buildId).isNotBlank();
        assertThat(host.path("assetsBase").asString()).endsWith("/" + buildId);
        assertThat(host.has("apiBase")).as(host.toString()).isTrue();
        assertThat(host.path("csrf").has("headerName")).as(host.toString()).isTrue();
    }

    @Test
    @Order(1302)
    default void theFormsBundlesAreServedImmutableUnderTheBuildId() {
        String base = assetsBase();
        Reply form = http().get(base + "/datum-form.js");
        assertThat(form.status()).as(form.toString()).isEqualTo(200);
        assertThat(form.mediaType()).isEqualTo("text/javascript");
        assertThat(form.header("Cache-Control")).hasValueSatisfying(value -> assertThat(value).contains("immutable"));
        assertThat(form.body()).isNotEmpty();
        assertThat(http().get(base + "/datum-wasm.js").status()).isEqualTo(200);
    }

    @Test
    @Order(1303)
    default void theGlueIsServed() {
        Reply glue = http().get(target().assetsPath() + "/datum-host.js");
        assertThat(glue.status()).as(glue.toString()).isEqualTo(200);
        assertThat(glue.mediaType()).isEqualTo("text/javascript");
        assertThat(glue.text()).contains("DatumHost").contains("If-Match");
    }

    @Test
    @Order(1304)
    default void theBuildersFilesFollowTheSwitch() {
        String base = assetsBase();
        assertThat(http().get(base + "/datum-builder.js").status()).isEqualTo(target().builderEnabled() ? 200 : 404);
        if (!target().builderEnabled()) {
            for (String spelling : new String[] {"DATUM-BUILDER.JS", "datum-builder-not-in-the-list.js", "builder-fonts/geist-variable.woff2"}) {
                assertThat(http().get(base + "/" + spelling).status()).as(spelling).isEqualTo(404);
            }
            for (String spelling : new String[] {"sub/../datum-builder.js", "datum-builder.js%2e"}) {
                assertThat(http().get(base + "/" + spelling).status()).as(spelling).isIn(400, 404);
            }
        }
    }

    @Test
    @Order(1305)
    default void aWrongBuildIdAndAPathOutOfTheAssetsAreNotFound() {
        assertThat(http().get(target().assetsPath() + "/nope/datum-form.js").status()).isEqualTo(404);
        String base = assetsBase();
        // Over the wire a server may refuse a dot segment itself (400) before Datum sees it; either way nothing is served.
        for (String path : new String[] {"/../manifest.json", "/%2e%2e/manifest.json", "/sub/../../manifest.json"}) {
            assertThat(http().get(base + path).status()).as(path).isIn(400, 404);
        }
    }
}
