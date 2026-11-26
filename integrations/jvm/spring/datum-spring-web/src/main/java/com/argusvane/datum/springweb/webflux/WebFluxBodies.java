package com.argusvane.datum.springweb.webflux;

import com.argusvane.datum.web.json.DatumJsonMapper;
import com.argusvane.datum.web.json.JsonBodies;
import org.springframework.core.io.buffer.DataBufferLimitException;
import org.springframework.core.io.buffer.DataBufferUtils;
import org.springframework.http.server.reactive.ServerHttpRequest;
import reactor.core.publisher.Mono;
import tools.jackson.databind.JsonNode;

/**
 * Reads a JSON request body in a reactive handler: 415 for a non-JSON Content-Type, the cap counted on the raw
 * stream (413 {@code bad_document}), then the parse (400 {@code bad_document}). Handlers take the request
 * instead of {@code bodyToMono} so nothing is decoded before the cap applies.
 */
public final class WebFluxBodies {

    private WebFluxBodies() {
    }

    /** The raw body, after the Content-Type and size checks; errors are Datum exceptions in the Mono. */
    public static Mono<byte[]> readJsonBytes(ServerHttpRequest request, long cap) {
        try {
            JsonBodies.requireJson(request.getHeaders().getFirst("Content-Type"));
        } catch (RuntimeException refusal) {
            return Mono.error(refusal);
        }
        long declared = request.getHeaders().getContentLength();
        if (declared > cap) {
            return Mono.error(JsonBodies.tooLarge(cap));
        }
        int limit = (int) Math.min(Integer.MAX_VALUE - 8, cap);
        return DataBufferUtils.join(request.getBody(), limit)
            .map(buffer -> {
                try {
                    byte[] bytes = new byte[buffer.readableByteCount()];
                    buffer.read(bytes);
                    return bytes;
                } finally {
                    DataBufferUtils.release(buffer);
                }
            })
            .onErrorMap(DataBufferLimitException.class, e -> JsonBodies.tooLarge(cap))
            .defaultIfEmpty(new byte[0]);
    }

    /** The parsed body. */
    public static Mono<JsonNode> readJson(ServerHttpRequest request, long cap, DatumJsonMapper json) {
        return readJsonBytes(request, cap).handle((bytes, sink) -> {
            try {
                sink.next(JsonBodies.parse(json, bytes));
            } catch (RuntimeException e) {
                sink.error(e);
            }
        });
    }
}
