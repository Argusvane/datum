package com.argusvane.datum.ui.contract;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.ui.BuilderFiles;
import com.argusvane.datum.web.assets.DatumAssets;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpHeaders;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * What the ui module lets out of the assets directory, the same on both stacks: the form files and the glue
 * always, the builder files only when {@code datum.builder.enabled}. The subclasses supply the stack and the
 * switch; the files are the real ones from the generated assets (a test run needs {@code npm run jvm:assets}).
 */
public abstract class AbstractAssetsContract {

    private static final JsonMapper JSON = JsonMapper.builder().build();

    /** A reply, stack-neutral. */
    public record Reply(int status, HttpHeaders headers, byte[] body) {

        public String text() {
            return new String(body, java.nio.charset.StandardCharsets.UTF_8);
        }
    }

    @Autowired
    protected DatumAssets assets;

    protected abstract Reply get(String path);

    protected abstract boolean builderEnabled();

    private Reply asset(String file) {
        return get(assets.assetUrl(file));
    }

    /** The builder files the jar actually carries (the list also names files that belong to the PDF jar). */
    private List<String> carriedBuilderFiles() throws IOException {
        List<String> carried = new ArrayList<>();
        try (InputStream in = getClass().getClassLoader().getResourceAsStream(BuilderFiles.RESOURCE)) {
            assertThat(in).as("builder-files.json is in the ui jar").isNotNull();
            JsonNode files = JSON.readTree(in).get("files");
            for (JsonNode file : files) {
                if (getClass().getClassLoader().getResource("META-INF/datum/assets/" + file.asString()) != null) {
                    carried.add(file.asString());
                }
            }
        }
        assertThat(carried).contains("datum-builder.js");
        return carried;
    }

    @Test
    void formFilesAreServedWhateverTheSwitch() {
        Reply form = asset("datum-form.js");
        assertThat(form.status()).isEqualTo(200);
        assertThat(form.headers().getContentType().toString()).startsWith("text/javascript");
        assertThat(form.headers().getFirst("Cache-Control")).contains("immutable");
        assertThat(form.body()).isNotEmpty();
        assertThat(asset("datum-wasm.js").status()).isEqualTo(200);
    }

    @Test
    void hostJsonAndTheGlueAreServed() {
        Reply host = get(assets.hostJsonUrl());
        assertThat(host.status()).isEqualTo(200);
        assertThat(host.text()).contains(assets.buildId()).contains("apiBase");
        Reply glue = get(assets.glueUrl());
        assertThat(glue.status()).isEqualTo(200);
        assertThat(glue.headers().getContentType().toString()).startsWith("text/javascript");
        // The glue script carries the builder wiring, so its "not available" stub message is absent.
        assertThat(glue.text()).doesNotContain("DatumHost.builder() is not available");
        assertThat(glue.text()).contains("X-Datum-Locale-Changes").contains("If-Match");
    }

    @Test
    void builderFilesFollowTheSwitch() throws IOException {
        for (String file : carriedBuilderFiles()) {
            Reply reply = asset(file);
            assertThat(reply.status()).as(file).isEqualTo(builderEnabled() ? 200 : 404);
        }
    }

    @Test
    void builderFilesAreNotReachableByAnotherSpelling() {
        if (builderEnabled()) {
            return;
        }
        assertThat(asset("DATUM-BUILDER.JS").status()).isEqualTo(404);
        assertThat(asset("datum-builder-not-in-the-list.js").status()).isEqualTo(404);
        assertThat(asset("builder-fonts/geist-variable.woff2").status()).isEqualTo(404);
        assertThat(asset("sub/../datum-builder.js").status()).isEqualTo(404);
        assertThat(asset("datum-builder.js%2e").status()).isEqualTo(404);
    }

    @Test
    void aWrongBuildIdIsNotFound() {
        assertThat(get(assets.assetsRoot() + "/nope/datum-form.js").status()).isEqualTo(404);
    }

    /**
     * The builder's asset gate sits in front of Spring's resource handler, so the spellings the framework would read as the
     * builder's files are attacked here, on each stack: percent-encoded letters and dots, dot and empty segments,
     * path parameters, case variants (also by Unicode folding), a trailing dot or slash, backslashes, a NUL and a
     * query. With the builder off none of them is served (404, or 400 where the server refuses it first). With it on the
     * plain name is served, and the gate also runs on the raw URI, so a doubled or trailing slash is a 404 on both stacks.
     */
    @Test
    void noSpellingOfAWithheldFileGetsThroughTheResourceHandler() {
        if (builderEnabled()) {
            for (String slashy : new String[] {"datum-builder.js/", "/datum-builder.js", "//datum-builder.js", "sub/../datum-builder.js"}) {
                try {
                    assertThat(asset(slashy).status()).as(slashy).isIn(400, 404);
                } catch (AssertionError | RuntimeException e) {
                    // refused before it was sent
                }
            }
            return;
        }
        String[] spellings = {"DATUM-BUILDER.JS", "Datum-Builder.js", "datum-builder.JS", "datum-builder.js;v=1", "datum-builder.js;",
            ";datum-builder.js", "sub;x=y/../datum-builder.js", "datum-builder.js/", "datum-builder.js%2f", "datum-builder.js%00", "datum-builder.js%2e",
            "datum-builder.js%2E", "datum-builder.js%20", "datum-builder.js%0a", "datum-builder.js%5c", "datum-builder.js%3a", "datum-builder.js%3b",
            "%64atum-builder.js", "datum%2dbuilder.js", "datum-builder%2ejs", "%2e/datum-builder.js", "./datum-builder.js", ".//datum-builder.js",
            "sub/../datum-builder.js", "sub/%2e%2e/datum-builder.js", "%2e%2e/datum-builder.js", "..%2fdatum-builder.js", "%2e%2e%2fdatum-builder.js",
            "/datum-builder.js", "//datum-builder.js", "%5cdatum-builder.js", "datum-builder.\u212ajs", "datum-builder.%C5%BFs", "%E2%84%AAatum-builder.js",
            "builder-fonts/GEIST-VARIABLE.WOFF2", "builder-fonts/geist-variable.woff2;x", "builder-fonts/../datum-builder.js"};
        for (String spelling : spellings) {
            Reply reply = null;
            try {
                reply = asset(spelling);
            } catch (AssertionError | RuntimeException e) {
                // A client or server that refuses to send the spelling at all is a refusal too.
                continue;
            }
            assertThat(reply.status()).as(spelling).isIn(400, 404);
        }
    }

    @Test
    void nothingOutsideTheAssetsIsReadThroughTheResourceHandler() {
        String base = assets.assetsBase();
        for (String spelling : new String[] {"/../manifest.json", "/%2e%2e/manifest.json", "/sub/../../manifest.json", "/..%2f..%2fmanifest.json",
            "/%2e%2e%2f%2e%2e%2fmanifest.json", "/..;/manifest.json", "/%2e%2e;/manifest.json", "/..\\manifest.json", "/%252e%252e/manifest.json",
            "/manifest.json", "/NOTICE", "/../../../../etc/passwd", "/..%00/manifest.json", "/%u002e%u002e/manifest.json"}) {
            Reply reply = null;
            try {
                reply = get(base + spelling);
            } catch (AssertionError | RuntimeException e) {
                continue;
            }
            // The one name that is a real file below the build id: manifest.json and NOTICE sit one level above the files.
            assertThat(reply.status()).as(spelling).isIn(400, 404);
        }
    }

    /**
     * One wire for every miss, on both stacks (the subclasses run this same test): a refusal by the gate, a file that
     * passes the gate but is not there, a trailing or doubled slash, a trailing dot and a path parameter all answer a
     * bare 404 with {@code Cache-Control: no-store}, so a client or CDN rule sees the same answer whichever stack runs.
     */
    @Test
    void everyMissIsTheSameBareNoStore404OnBothStacks() {
        for (String spelling : new String[] {"not-a-file.js", "datum-form.js.", "datum-form.js/", "/datum-form.js", "datum-form.js;v=1",
            "feature-files.json", "sub/../datum-form.js", "%64atum-form.js", "pdfjs/"}) {
            Reply reply;
            try {
                reply = asset(spelling);
            } catch (AssertionError | RuntimeException e) {
                continue;
            }
            assertThat(reply.status()).as(spelling).isEqualTo(404);
            assertThat(reply.body()).as(spelling + " body").isEmpty();
            assertThat(reply.headers().getFirst("Cache-Control")).as(spelling + " cache").isEqualTo("no-store");
        }
        Reply wrongBuild = get(assets.assetsRoot() + "/nope/datum-form.js");
        assertThat(wrongBuild.status()).isEqualTo(404);
        assertThat(wrongBuild.body()).isEmpty();
        assertThat(wrongBuild.headers().getFirst("Cache-Control")).isEqualTo("no-store");
    }

    /** A refusal is never kept by a cache (a later deploy may put a file at that URL), and a success is immutable. */
    @Test
    void aRefusalIsNotCachedAndASuccessIsImmutable() {
        Reply missing = asset("not-a-file.js");
        assertThat(missing.status()).isEqualTo(404);
        Reply wrongBuild = get(assets.assetsRoot() + "/nope/datum-form.js");
        assertThat(wrongBuild.status()).isEqualTo(404);
        assertThat(wrongBuild.headers().getFirst("Cache-Control")).contains("no-store");
        assertThat(asset("datum-form.js").headers().getFirst("Cache-Control")).contains("immutable").doesNotContain("no-store");
    }
}
