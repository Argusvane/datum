package com.argusvane.datum.web.openapi;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.springweb.webflux.FluxTestApp;
import java.net.URI;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.test.web.reactive.server.WebTestClient;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** The same on WebFlux: the group exists (the ordering trap would make it 404) and carries the shared components. */
@SpringBootTest(classes = FluxTestApp.class, webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
    "datum.test.docs=true",
    "spring.main.web-application-type=reactive"})
class OpenApiWebFluxTest {

    @LocalServerPort
    int port;

    private JsonNode get(String path) throws Exception {
        byte[] body = WebTestClient.bindToServer().baseUrl("http://localhost:" + port).build()
            .get().uri(URI.create("http://localhost:" + port + path)).exchange().expectStatus().isOk()
            .expectBody().returnResult().getResponseBody();
        return JsonMapper.builder().build().readTree(body);
    }

    @Test
    void theGroupExistsOnWebFlux() throws Exception {
        JsonNode components = get("/v3/api-docs/datum-test").get("components");
        assertThat(components.get("schemas").propertyNames()).contains("ErrorsBody", "ErrorItem", "ProblemDetail");
        assertThat(components.get("responses").propertyNames()).contains("TooManyRequests", "Unavailable");
    }
}
