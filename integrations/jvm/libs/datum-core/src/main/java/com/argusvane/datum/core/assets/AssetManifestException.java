package com.argusvane.datum.core.assets;

import com.argusvane.datum.core.DatumException;

/**
 * The first-party Datum jars on the classpath do not agree on their assets (different {@code buildId}), or a
 * manifest cannot be read. Mixed jars would run one build's bundles against another's programs, so startup
 * refuses; the fix is one Datum version across the application.
 */
public class AssetManifestException extends DatumException {

    private static final long serialVersionUID = 1L;

    public AssetManifestException(String message) {
        super("assets.mismatch", 500, message);
    }

    public AssetManifestException(String message, Throwable cause) {
        super("assets.unreadable", 500, message, cause);
    }
}
