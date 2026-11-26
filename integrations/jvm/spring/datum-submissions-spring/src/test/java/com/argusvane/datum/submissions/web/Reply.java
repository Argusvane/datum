package com.argusvane.datum.submissions.web;

import org.springframework.http.HttpHeaders;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** A reply, stack-neutral. */
public record Reply(int status, HttpHeaders headers, byte[] body) {

    private static final JsonMapper JSON = JsonMapper.builder().build();

    public String text() {
        return new String(body, java.nio.charset.StandardCharsets.UTF_8);
    }

    public JsonNode json() {
        return JSON.readTree(body);
    }

    public String code() {
        return json().get("errors").get(0).get("code").asString();
    }
}
