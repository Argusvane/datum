package com.argusvane.datum.webauthn.web;

import java.security.Principal;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * What the passkey endpoints read of a request, with no servlet or reactive type in it: the MVC and WebFlux
 * adapters fill it, {@link PasskeysApi} decides.
 *
 * @param contentType the Content-Type as sent, or null
 * @param headers the request headers, names compared case-insensitively
 * @param remoteAddress the client address (after the application's own forwarded-header handling), or null
 * @param principal who is asking, or null when anonymous: the passkey's subject and the Test context's question
 *     (Datum's own work; who may reach the route at all is the application's security)
 */
public record PasskeysRequest(String contentType, Map<String, List<String>> headers, String remoteAddress, Principal principal) {

    public PasskeysRequest {
        Map<String, List<String>> folded = new TreeMap<>(String.CASE_INSENSITIVE_ORDER);
        if (headers != null) {
            headers.forEach((name, values) -> {
                if (name != null) {
                    folded.put(name, values == null ? List.of() : List.copyOf(values));
                }
            });
        }
        headers = Collections.unmodifiableMap(folded);
    }

    /** The first value of a header, or null. */
    public String header(String name) {
        List<String> values = headers.get(name);
        return values == null || values.isEmpty() ? null : values.get(0);
    }
}
