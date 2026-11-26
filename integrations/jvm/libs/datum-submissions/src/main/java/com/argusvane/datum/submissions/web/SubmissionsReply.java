package com.argusvane.datum.submissions.web;

import java.util.Map;
import java.util.Objects;

/**
 * What a submissions endpoint answers, with no servlet or reactive type in it, so MVC and WebFlux (and any
 * later binding, for example Quarkus) write the same response.
 *
 * @param status the HTTP status (every refusal is an exception the error mapper answers instead)
 * @param headers response headers
 * @param body the JSON body
 */
public record SubmissionsReply(int status, Map<String, String> headers, byte[] body) {

    public SubmissionsReply {
        headers = Map.copyOf(headers);
        Objects.requireNonNull(body, "body");
    }
}
