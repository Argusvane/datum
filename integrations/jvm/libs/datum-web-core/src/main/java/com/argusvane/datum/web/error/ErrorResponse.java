package com.argusvane.datum.web.error;

import java.util.LinkedHashMap;
import java.util.Map;
import tools.jackson.databind.json.JsonMapper;

/**
 * What an error answers with, stack-neutral: both adapters write it the same way.
 *
 * @param status      the HTTP status
 * @param headers     response headers beside {@code Content-Type} (for example {@code Retry-After})
 * @param contentType {@code application/json}, or {@code application/problem+json} under RFC 9457
 * @param body        the JSON object to write
 */
public record ErrorResponse(int status, Map<String, String> headers, String contentType, Map<String, Object> body) {

    public static final String JSON = "application/json";
    public static final String PROBLEM_JSON = "application/problem+json";

    public ErrorResponse {
        headers = headers == null ? Map.of() : Map.copyOf(new LinkedHashMap<>(headers));
        body = body == null ? Map.of() : body;
    }

    /** The body as UTF-8 JSON bytes, written with the given mapper (the adapters write bytes themselves so the application's message converters never reshape an error). */
    public byte[] bodyBytes(JsonMapper mapper) {
        return mapper.writeValueAsBytes(body);
    }
}
