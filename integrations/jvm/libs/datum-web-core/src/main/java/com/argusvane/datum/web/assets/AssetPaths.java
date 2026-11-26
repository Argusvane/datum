package com.argusvane.datum.web.assets;

import java.util.Optional;

/**
 * Turns the part of a URL after the build id into a safe classpath-relative path.
 *
 * <p>The files are looked up as classpath resources by the framework's resource handler, so a path must never climb out
 * of {@code META-INF/datum/assets/}, and what the gate checks must be what the handler resolves. Anything the framework
 * could read differently is refused outright: a percent sign (closing {@code %2e%2e} and {@code %2f}), a semicolon (path
 * parameters are dropped by Spring's path matching), a backslash, a colon, and any byte outside printable ASCII (a
 * case-insensitive file system folds characters such as the Kelvin sign and the long s onto ASCII letters). Generated file
 * names never need one. A segment that ends in a dot is refused as well (it covers the dot segments).
 */
final class AssetPaths {

    private AssetPaths() {
    }

    /** The cleaned relative path, or empty for anything but plain {@code a/b/c.ext} segments. */
    static Optional<String> clean(String raw) {
        if (raw == null || raw.isEmpty() || raw.length() > 512) {
            return Optional.empty();
        }
        String path = raw;
        if (path.startsWith("/") || path.endsWith("/")) {
            return Optional.empty();
        }
        for (int i = 0; i < path.length(); i++) {
            char c = path.charAt(i);
            if (c <= 0x20 || c >= 0x7f || c == '%' || c == '\\' || c == ':' || c == '?' || c == '#' || c == ';') {
                return Optional.empty();
            }
        }
        for (String segment : path.split("/", -1)) {
            // A segment ending in a dot is refused too: a Windows file system (an exploded class path in a dev run) reads
            // "x.js." as "x.js", which would slip past the exact-name checks of omitted and withheld files. Generated names never end in one.
            if (segment.isEmpty() || segment.endsWith(".")) {
                return Optional.empty();
            }
        }
        return Optional.of(path);
    }
}
