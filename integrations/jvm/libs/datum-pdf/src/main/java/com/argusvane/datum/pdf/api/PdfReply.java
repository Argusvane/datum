package com.argusvane.datum.pdf.api;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/**
 * One answer of {@link PdfApi}, in bytes, for a web adapter to write as it is: the status, the content type, the
 * headers and the body. Refusals are not replies: they are Datum exceptions the adapters' error handlers answer.
 *
 * @param status the HTTP status
 * @param contentType {@code application/pdf}, {@code application/json} or {@code application/x-pem-file}
 * @param headers the headers, in order
 * @param body the body
 */
public record PdfReply(int status, String contentType, Map<String, String> headers, byte[] body) {

    public PdfReply {
        Objects.requireNonNull(contentType, "contentType");
        headers = java.util.Collections.unmodifiableMap(new LinkedHashMap<>(headers == null ? Map.of() : headers));
        body = Objects.requireNonNull(body, "body").clone();
    }

    @Override
    public byte[] body() {
        return body.clone();
    }
}
