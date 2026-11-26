package com.argusvane.datum.timestamp.web;

import java.nio.charset.StandardCharsets;
import org.springframework.http.HttpHeaders;

/** A reply, stack-neutral. */
public record Reply(int status, HttpHeaders headers, byte[] body) {

    public String text() {
        return new String(body, StandardCharsets.UTF_8);
    }

    public String type() {
        String type = headers.getFirst(HttpHeaders.CONTENT_TYPE);
        return type == null ? "" : type;
    }
}
