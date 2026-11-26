package com.argusvane.datum.webauthn.web;

import java.util.Map;
import java.util.Objects;

/**
 * What a passkey endpoint answers, with no servlet or reactive type in it, so MVC and WebFlux (and any later
 * binding) write the same response. Every refusal is an exception the error mapper answers instead.
 *
 * @param status the HTTP status
 * @param headers response headers
 * @param body the JSON body
 */
public record PasskeysReply(int status, Map<String, String> headers, byte[] body) {

    public PasskeysReply {
        headers = Map.copyOf(headers);
        Objects.requireNonNull(body, "body");
    }
}
