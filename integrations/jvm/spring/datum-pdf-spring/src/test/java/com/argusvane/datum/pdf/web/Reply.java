package com.argusvane.datum.pdf.web;

import org.springframework.http.HttpHeaders;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** A reply, stack-neutral. */
record Reply(int status, HttpHeaders headers, byte[] body) {

    private static final JsonMapper JSON = JsonMapper.builder().build();

    String text() {
        return new String(body, java.nio.charset.StandardCharsets.ISO_8859_1);
    }

    JsonNode json() {
        return JSON.readTree(body);
    }

    String code() {
        JsonNode first = json().path("errors").path(0);
        return first.path("code").asString(json().path("code").asString(""));
    }
}
