package com.argusvane.datum.core.canonical;

import tools.jackson.databind.JsonNode;

/**
 * RFC 8785 JSON Canonicalization, the text WebAuthn-signed submissions are signed over
 * (the engine's {@code canonicalizeJcs}, held to the engine's RFC 8785 vectors {@code jcs-vectors.json}).
 *
 * <p>It differs from {@link CanonicalJson} in one way: members sort by UTF-16 code unit alone, so
 * {@code "10"} comes before {@code "2"} (the kernel's form puts array-index keys first, as a JavaScript object
 * lists them). A number with no JSON form (NaN, infinity) is refused.
 */
public final class Jcs {

    private Jcs() {
    }

    /** The canonical text of {@code value}. */
    public static String canonicalize(JsonNode value) {
        return CanonicalJson.write(value, false);
    }
}
