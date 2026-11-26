package com.argusvane.datum.web.assets;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * One answer of the small asset documents ({@code host.json}, the glue script), as every web binding writes it: the
 * status, the headers ({@code Content-Type} and {@code Cache-Control} included) and the bytes. The versioned files are
 * not answers of this kind: the framework's resource handler serves them behind {@link AssetService#gate}. The bindings
 * copy this out and choose nothing.
 *
 * @param status  200
 * @param headers response headers, in order
 * @param body    the document's bytes
 */
public record AssetReply(int status, Map<String, String> headers, byte[] body) {

    public AssetReply {
        headers = Collections.unmodifiableMap(new LinkedHashMap<>(headers));
    }
}
