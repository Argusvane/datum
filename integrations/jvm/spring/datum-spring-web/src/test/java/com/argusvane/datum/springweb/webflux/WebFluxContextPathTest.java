package com.argusvane.datum.springweb.webflux;

import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.test.web.reactive.server.WebTestClient;

/** The WebFlux twin of the MVC context-path test: base-path /shop, routes registered without it. */
@SpringBootTest(classes = FluxTestApp.class, webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
    "datum.web.assets.enabled=true", "spring.main.web-application-type=reactive", "spring.webflux.base-path=/shop"})
class WebFluxContextPathTest {

    @LocalServerPort
    int port;

    @Test
    void assetsAreServedUnderTheBasePath() {
        WebTestClient client = WebTestClient.bindToServer().baseUrl("http://localhost:" + port).build();
        client.get().uri("/shop/datum/assets/host.json").exchange().expectStatus().isOk()
            .expectBody(String.class).value(body -> org.assertj.core.api.Assertions.assertThat(body)
                .contains("/shop/datum/assets/testbuild1"));
        client.get().uri("/shop/datum/assets/testbuild1/datum-form.js").exchange().expectStatus().isOk()
            .expectHeader().value("Cache-Control", v -> org.assertj.core.api.Assertions.assertThat(v).contains("immutable"));
        client.get().uri("/shop/datum/assets/testbuild1/DATUM-BUILDER.JS").exchange().expectStatus().isNotFound();
    }
}
