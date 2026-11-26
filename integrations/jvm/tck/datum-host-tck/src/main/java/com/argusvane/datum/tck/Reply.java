package com.argusvane.datum.tck;

import java.net.http.HttpHeaders;
import java.nio.charset.StandardCharsets;
import java.util.Optional;
import tools.jackson.databind.JsonNode;

/** One answer of the host under test, as it came over the wire. */
public record Reply(int status, HttpHeaders headers, byte[] body) {

    /** The body as UTF-8 text. */
    public String text() {
        return new String(body, StandardCharsets.UTF_8);
    }

    /** The body as Latin-1 text (a PDF, a DER file), byte for character. */
    public String bytesAsText() {
        return new String(body, StandardCharsets.ISO_8859_1);
    }

    /** The body as JSON; an {@link AssertionError} naming the status and text when it is not. */
    public JsonNode json() {
        try {
            return TckFixtures.JSON.readTree(body);
        } catch (RuntimeException e) {
            throw new AssertionError("Not JSON (" + status + "): " + text(), e);
        }
    }

    /** The first value of a header. */
    public Optional<String> header(String name) {
        return headers.firstValue(name);
    }

    /** The media type of the body without parameters, lower case ({@code application/json}), or "". */
    public String mediaType() {
        String type = header("Content-Type").orElse("");
        int semicolon = type.indexOf(';');
        return (semicolon < 0 ? type : type.substring(0, semicolon)).strip().toLowerCase(java.util.Locale.ROOT);
    }

    /** The code of the first error of a Datum error body ({@code {errors: [{code, message}]}}). */
    public String code() {
        return json().path("errors").path(0).path("code").asString();
    }

    /** For assertion messages: the status and the start of the body. */
    @Override
    public String toString() {
        String text = mediaType().startsWith("text/") || mediaType().endsWith("json") ? text() : "<" + body.length + " bytes>";
        return status + " " + (text.length() > 600 ? text.substring(0, 600) + "..." : text);
    }
}
