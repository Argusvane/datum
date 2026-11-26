package com.argusvane.datum.springweb.mvc;

import com.argusvane.datum.web.json.DatumJsonMapper;
import com.argusvane.datum.web.json.JsonBodies;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.io.UncheckedIOException;
import tools.jackson.databind.JsonNode;

/**
 * Reads a JSON request body in a servlet controller: 415 for a non-JSON Content-Type, the cap counted on the
 * raw stream (413 {@code bad_document}), then the parse (400 {@code bad_document}). Controllers take the
 * request instead of a {@code @RequestBody} so nothing is buffered or decoded before the cap applies.
 */
public final class MvcBodies {

    private MvcBodies() {
    }

    /** The raw body, after the Content-Type and size checks. */
    public static byte[] readJsonBytes(HttpServletRequest request, long cap) {
        JsonBodies.requireJson(request.getContentType());
        try {
            return JsonBodies.read(request.getInputStream(), request.getContentLengthLong(), cap);
        } catch (IOException e) {
            throw new UncheckedIOException("The request body could not be read.", e);
        }
    }

    /** The parsed body. */
    public static JsonNode readJson(HttpServletRequest request, long cap, DatumJsonMapper json) {
        return JsonBodies.parse(json, readJsonBytes(request, cap));
    }
}
