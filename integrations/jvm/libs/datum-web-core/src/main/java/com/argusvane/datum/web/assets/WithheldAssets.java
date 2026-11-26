package com.argusvane.datum.web.assets;

/**
 * Names files the asset handler must answer 404 even though they are on the classpath.
 *
 * <p>The ui module provides a bean that withholds the builder's files unless {@code datum.builder.enabled}
 * (the builder bundle is not for visitors of a form page). Every bean of this type is asked; any {@code true}
 * withholds. Paths are relative to the versioned base, as in {@code feature-files.json}
 * ({@code datum-builder.js}, {@code builder-fonts/x.woff2}).
 */
@FunctionalInterface
public interface WithheldAssets {

    /** Whether the file at {@code path} (relative to the assets base) answers 404. */
    boolean withheld(String path);
}
