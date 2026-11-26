package com.argusvane.datum.springweb.webflux;

import java.util.List;
import org.springframework.core.Ordered;
import org.springframework.web.reactive.HandlerMapping;
import org.springframework.web.server.ServerWebExchange;
import org.springframework.web.server.WebHandler;
import reactor.core.publisher.Mono;

/**
 * Answers 405 with an {@code Allow} header for a wrong method on a path Datum serves, and only when nothing else
 * would handle the request.
 *
 * <p>A handler mapping, not a router function: {@code DispatcherHandler} asks the mappings in order, annotated
 * controllers first, router functions next, so this one (ordered after both, before the static resource mapping)
 * is reached only by a request no controller and no router claimed. An application's own
 * {@code @DeleteMapping} or router route on a Datum path therefore still works, which a path-wide 405 route in
 * Datum's routers could not allow. A request whose method Datum serves is
 * left alone, so an unmapped route stays the plain 404.
 */
public final class DatumMethodNotAllowedMapping implements HandlerMapping, Ordered {

    /** Before the resource handler mapping ({@code LOWEST_PRECEDENCE - 1}), after annotated and functional routes. */
    public static final int ORDER = Ordered.LOWEST_PRECEDENCE - 2;

    private final DatumMethodRules rules;

    public DatumMethodNotAllowedMapping(DatumMethodRules rules) {
        this.rules = rules;
    }

    @Override
    public int getOrder() {
        return ORDER;
    }

    @Override
    public Mono<Object> getHandler(ServerWebExchange exchange) {
        List<String> allowed = rules.allowed(exchange.getRequest().getPath().pathWithinApplication());
        if (allowed.isEmpty() || allowed.contains(exchange.getRequest().getMethod().name())) {
            return Mono.empty();
        }
        WebHandler handler = served -> {
            served.getResponse().setStatusCode(org.springframework.http.HttpStatusCode.valueOf(405));
            served.getResponse().getHeaders().set("Allow", String.join(", ", allowed));
            return served.getResponse().setComplete();
        };
        return Mono.just(handler);
    }
}
