package com.argusvane.datum.springweb.webflux;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.http.HttpMethod;
import org.springframework.mock.http.server.reactive.MockServerHttpRequest;
import org.springframework.mock.web.server.MockServerWebExchange;
import org.springframework.web.server.WebHandler;

class DatumMethodNotAllowedMappingTest {

    private final DatumMethodRules rules = new DatumMethodRules()
        .allow("/api/forms/{key}/translations", "GET", "HEAD")
        .allow("/api/forms/{key}/translations", "PUT")
        .allow("/api/forms", "POST");
    private final DatumMethodNotAllowedMapping mapping = new DatumMethodNotAllowedMapping(rules);

    private MockServerWebExchange exchange(HttpMethod method, String path) {
        return MockServerWebExchange.from(MockServerHttpRequest.method(method, path).build());
    }

    @Test
    void theAllowValueIsTheUnionOfEveryRulesMethodsInAFixedOrder() {
        assertThat(rules.allowed("/api/forms/intake/translations")).containsExactly("GET", "HEAD", "PUT");
        assertThat(rules.allowed("/api/forms")).containsExactly("POST");
        assertThat(rules.allowed("/api/other")).isEmpty();
    }

    @Test
    void aWrongMethodOnAKnownPathAnswers405WithAllow() {
        MockServerWebExchange exchange = exchange(HttpMethod.DELETE, "/api/forms/intake/translations");
        Object handler = mapping.getHandler(exchange).block();
        assertThat(handler).isInstanceOf(WebHandler.class);
        ((WebHandler) handler).handle(exchange).block();
        assertThat(exchange.getResponse().getStatusCode().value()).isEqualTo(405);
        assertThat(exchange.getResponse().getHeaders().getFirst("Allow")).isEqualTo("GET, HEAD, PUT");
    }

    @Test
    void aServedMethodAndAnUnknownPathAreLeftToTheRest() {
        assertThat(mapping.getHandler(exchange(HttpMethod.PUT, "/api/forms/intake/translations")).block()).isNull();
        assertThat(mapping.getHandler(exchange(HttpMethod.GET, "/api/forms/intake/translations")).block()).isNull();
        assertThat(mapping.getHandler(exchange(HttpMethod.DELETE, "/somewhere/else")).block()).isNull();
    }

    @Test
    void itIsOrderedAfterControllersAndRoutersAndBeforeTheResourceMapping() {
        assertThat(mapping.getOrder()).isEqualTo(Integer.MAX_VALUE - 2);
    }
}
