package com.argusvane.datum.springweb.webflux;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.security.Principal;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.mock.http.server.reactive.MockServerHttpRequest;
import org.springframework.mock.web.server.MockServerWebExchange;
import org.springframework.web.reactive.function.server.ServerRequest;

/** The one reactive rule for the pieces of a request view. */
class WebFluxRequestViewsTest {

    private static ServerRequest request(MockServerHttpRequest.BaseBuilder<?> builder) {
        return ServerRequest.create(MockServerWebExchange.from(builder), List.of());
    }

    @Test
    void headersAddressAndContentTypeComeFromTheRequest() throws Exception {
        ServerRequest request = request(MockServerHttpRequest.post("/x").header("X-Probe", "one", "two").header("Content-Type", "application/json")
            .remoteAddress(new InetSocketAddress(InetAddress.getByName("203.0.113.7"), 5000)));
        assertThat(WebFluxRequestViews.headers(request).get("X-Probe")).containsExactly("one", "two");
        assertThat(WebFluxRequestViews.contentType(request)).isEqualTo("application/json");
        assertThat(WebFluxRequestViews.remoteAddress(request)).isEqualTo("203.0.113.7");
    }

    @Test
    void noSocketAddressReadsAsNullAndNoPrincipalAsEmpty() {
        ServerRequest request = request(MockServerHttpRequest.get("/x"));
        assertThat(WebFluxRequestViews.remoteAddress(request)).isNull();
        assertThat(WebFluxRequestViews.principal(request).block()).isEmpty();
    }

    @Test
    void aPrincipalIsPassedThroughAsAnOptional() {
        Principal ada = () -> "ada";
        MockServerWebExchange exchange = MockServerWebExchange.from(MockServerHttpRequest.get("/x"));
        ServerRequest request = ServerRequest.create(exchange.mutate().principal(reactor.core.publisher.Mono.just(ada)).build(), List.of());
        assertThat(WebFluxRequestViews.principal(request).block()).containsSame(ada);
    }
}
