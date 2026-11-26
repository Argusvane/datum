package com.argusvane.datum.ui;

import com.argusvane.datum.web.assets.WithheldAssets;

/**
 * Withholds the builder's files (404) unless {@code datum.builder.enabled}: the builder bundle is not for the
 * visitors of a form page, and the editor's code is no business of a site that never authors forms.
 *
 * <p>Both web stacks use it through {@code AssetService}, which asks every {@link WithheldAssets} bean for each
 * request, so the rule is written once.
 */
public final class BuilderAssetGate implements WithheldAssets {

    private final BuilderFiles files;
    private final UiSettings settings;

    public BuilderAssetGate(BuilderFiles files, UiSettings settings) {
        this.files = files;
        this.settings = settings;
    }

    @Override
    public boolean withheld(String path) {
        return !settings.builderEnabled() && files.isBuilderFile(path);
    }
}
