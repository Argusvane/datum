package com.argusvane.datum.timestamp.web;

import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/**
 * A timestamp endpoint's answer, stack-neutral: the status, the media type, the other headers and the bytes.
 *
 * @param status the HTTP status
 * @param contentType the media type, with charset where it is text
 * @param headers more headers ({@code Retry-After}, {@code WWW-Authenticate}, {@code Cache-Control}, ...)
 * @param body the body
 */
public record TsaHttpReply(int status, String contentType, Map<String, String> headers, byte[] body) {

    public TsaHttpReply {
        Objects.requireNonNull(contentType, "contentType");
        headers = Map.copyOf(headers);
        body = Objects.requireNonNull(body, "body").clone();
    }

    @Override
    public byte[] body() {
        return body.clone();
    }

    /** A plain-text answer for a request that gets no TimeStampResp (a 401, 403, 413, 415, 429 or 503 of the endpoint). */
    static TsaHttpReply plain(int status, String text, Map<String, String> more) {
        Map<String, String> headers = new LinkedHashMap<>(more);
        headers.put("Cache-Control", "no-store");
        return new TsaHttpReply(status, "text/plain; charset=utf-8", headers, (text + "\n").getBytes(StandardCharsets.UTF_8));
    }

    static TsaHttpReply plain(int status, String text) {
        return plain(status, text, Map.of());
    }
}
