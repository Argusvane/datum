package com.argusvane.datum.sandbox.protocol;

import org.jspecify.annotations.Nullable;

/**
 * The numeric {@code major.minor.patch} comparison the ABI gates need.
 *
 * <p>An ABI string is three numbers, so anything else is no version at all and the gate refuses it, as
 * the program itself refuses a malformed abi in a request (ABI-04).
 */
final class Versions {

    private Versions() {
    }

    /** The three numbers of {@code x.y.z}, or {@code null} for anything else. */
    static int @Nullable [] parse(@Nullable String version) {
        if (version == null || !version.matches("(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})")) {
            return null;
        }
        String[] parts = version.split("\\.");
        return new int[] {Integer.parseInt(parts[0]), Integer.parseInt(parts[1]), Integer.parseInt(parts[2])};
    }

    static int compare(int[] a, int[] b) {
        for (int i = 0; i < 3; i++) {
            int c = Integer.compare(a[i], b[i]);
            if (c != 0) {
                return c;
            }
        }
        return 0;
    }
}
