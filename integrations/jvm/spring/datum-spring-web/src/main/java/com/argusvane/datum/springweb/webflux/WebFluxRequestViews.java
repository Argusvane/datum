package com.argusvane.datum.springweb.webflux;

import java.net.InetSocketAddress;
import java.security.Principal;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.springframework.web.reactive.function.server.ServerRequest;
import reactor.core.publisher.Mono;

/**
 * The reactive twin of {@code MvcRequestViews}: one rule for the headers, the remote address
 * and the principal that every Datum handler on WebFlux builds its request view from. The remote address is the numeric
 * host of the socket address the server reports (after Spring's forwarded-header handling), never a name lookup.
 */
public final class WebFluxRequestViews {

    private WebFluxRequestViews() {
    }

    /** Every request header with all its values. */
    public static Map<String, List<String>> headers(ServerRequest request) {
        Map<String, List<String>> headers = new LinkedHashMap<>();
        request.headers().asHttpHeaders().forEach((name, values) -> headers.put(name, new ArrayList<>(values)));
        return headers;
    }

    /** The Content-Type header, or null. */
    public static String contentType(ServerRequest request) {
        return request.headers().firstHeader("Content-Type");
    }

    /** The client address as a host string, or null when the server reports none. */
    public static String remoteAddress(ServerRequest request) {
        return request.remoteAddress().map(WebFluxRequestViews::host).orElse(null);
    }

    /** The authenticated principal, empty when anonymous (a Mono cannot carry null). */
    public static Mono<Optional<Principal>> principal(ServerRequest request) {
        return request.principal().map(Optional::<Principal>of).defaultIfEmpty(Optional.empty());
    }

    private static String host(InetSocketAddress address) {
        return address.getAddress() != null ? address.getAddress().getHostAddress() : address.getHostString();
    }
}
