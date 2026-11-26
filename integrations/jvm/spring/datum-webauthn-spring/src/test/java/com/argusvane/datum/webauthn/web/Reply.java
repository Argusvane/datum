package com.argusvane.datum.webauthn.web;

import java.nio.charset.StandardCharsets;
import org.springframework.http.HttpHeaders;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** A reply, stack-neutral. */
public record Reply(int status, HttpHeaders headers, byte[] body) {

    private static final JsonMapper JSON = JsonMapper.builder().build();

    public String text() {
        return new String(body, StandardCharsets.UTF_8);
    }

    public JsonNode json() {
        return JSON.readTree(body);
    }

    /** The first error's code, or null. */
    public String code() {
        JsonNode errors = json().get("errors");
        return errors == null || !errors.isArray() || errors.isEmpty() ? null : errors.get(0).get("code").asString();
    }

    public String message() {
        return json().get("errors").get(0).get("message").asString();
    }
}
