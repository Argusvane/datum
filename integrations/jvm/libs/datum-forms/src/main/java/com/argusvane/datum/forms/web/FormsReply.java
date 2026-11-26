package com.argusvane.datum.forms.web;

import java.util.Map;

/**
 * What a forms endpoint answers, with no servlet or reactive type in it, so MVC and WebFlux write the same
 * response. A null {@code body} is an answer with no content (304).
 */
public record FormsReply(int status, Map<String, String> headers, byte[] body) {

    public FormsReply {
        headers = Map.copyOf(headers);
    }
}
