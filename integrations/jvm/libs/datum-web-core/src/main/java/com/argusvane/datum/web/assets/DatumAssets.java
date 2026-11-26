package com.argusvane.datum.web.assets;

import com.argusvane.datum.core.assets.AssetManifest;

/**
 * Where the browser loads Datum's bundles from and where its API lives: the bean pages (templates) read.
 *
 * <p>Values include the application's context path when it has one. {@code assetsBase} ends in the build id
 * ({@code /datum/assets/a9c057bb6c6f}) so every URL under it can be cached forever; the id changes with the
 * bundles (the manifest's {@code buildId}).
 *
 * @param enabled    whether the asset routes are served (false: assets switched off, or no manifest on the classpath)
 * @param buildId    the manifest's build id, {@code "dev"} when none was found
 * @param assetsRoot the unversioned assets path ({@code /datum/assets}); {@code host.json} and {@code datum-host.js} live here
 * @param assetsBase {@code assetsRoot/buildId}: the prefix of the immutable files
 * @param apiBase    the JSON endpoints' base ({@code /api})
 * @param manifest   the manifest the ids come from ({@link AssetManifest#absent()} when none)
 */
public record DatumAssets(boolean enabled, String buildId, String assetsRoot, String assetsBase, String apiBase,
                          AssetManifest manifest) {

    /** The URL of a versioned file, for example {@code assetUrl("datum-form.js")}. */
    public String assetUrl(String file) {
        return assetsBase + "/" + file;
    }

    /** The URL of the unversioned {@code host.json}. */
    public String hostJsonUrl() {
        return assetsRoot + "/host.json";
    }

    /** The URL of the page glue script. */
    public String glueUrl() {
        return assetsRoot + "/datum-host.js";
    }
}
