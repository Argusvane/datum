package com.argusvane.datum.springweb.webflux;

import com.argusvane.datum.web.error.ErrorMapper;
import com.argusvane.datum.web.error.ErrorResponse;
import com.argusvane.datum.web.json.DatumJsonMapper;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.core.io.buffer.DataBuffer;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.MediaType;
import org.springframework.http.server.reactive.ServerHttpResponse;
import org.springframework.web.server.ServerWebExchange;
import org.springframework.web.server.WebExceptionHandler;
import reactor.core.publisher.Mono;

/**
 * Answers the exceptions of Datum's routes through {@link ErrorMapper}, on WebFlux.
 *
 * <p>A {@code WebExceptionHandler} sees every failure of the application, so it answers only paths registered
 * in the {@link DatumRouteRegistry} (Spring's {@code PathPattern}s over the request's path) and hands the rest to the next handler untouched (the application's own
 * error handling and Boot's default stay in charge of everything else). Ordered before Boot's default error
 * handler (-1).
 */
@Order(Ordered.HIGHEST_PRECEDENCE + 10)
public class DatumWebFluxExceptionHandler implements WebExceptionHandler {

    private final ErrorMapper errors;
    private final DatumJsonMapper json;
    private final DatumRouteRegistry routes;

    public DatumWebFluxExceptionHandler(ErrorMapper errors, DatumJsonMapper json, DatumRouteRegistry routes) {
        this.errors = errors;
        this.json = json;
        this.routes = routes;
    }

    @Override
    public Mono<Void> handle(ServerWebExchange exchange, Throwable failure) {
        ServerHttpResponse response = exchange.getResponse();
        if (response.isCommitted()
            || !routes.matches(exchange.getRequest().getPath().pathWithinApplication())) {
            return Mono.error(failure);
        }
        return write(exchange, errors.map(failure), json);
    }

    /** Writes an {@link ErrorResponse} to the exchange (also for handlers that map an error themselves). */
    public static Mono<Void> write(ServerWebExchange exchange, ErrorResponse answer, DatumJsonMapper json) {
        ServerHttpResponse response = exchange.getResponse();
        response.setStatusCode(HttpStatusCode.valueOf(answer.status()));
        answer.headers().forEach((name, value) -> response.getHeaders().set(name, value));
        response.getHeaders().setContentType(MediaType.parseMediaType(answer.contentType()));
        byte[] bytes = answer.bodyBytes(json.mapper());
        response.getHeaders().setContentLength(bytes.length);
        DataBuffer buffer = response.bufferFactory().wrap(bytes);
        return response.writeWith(Mono.just(buffer));
    }
}
