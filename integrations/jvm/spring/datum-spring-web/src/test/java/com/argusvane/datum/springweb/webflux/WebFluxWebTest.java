package com.argusvane.datum.springweb.webflux;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.springweb.contract.AbstractWebContract;
import java.net.URI;
import org.junit.jupiter.api.BeforeEach;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.test.web.reactive.server.EntityExchangeResult;
import org.springframework.test.web.reactive.server.WebTestClient;

/** The same contract against a real (random-port) Netty server. */
@SpringBootTest(classes = FluxTestApp.class, webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
    "datum.web.assets.enabled=true",
    "datum.web.api.max-body-size=1KB",
    "datum.web.assets.omit-features=journeys",
    "spring.main.web-application-type=reactive"})
class WebFluxWebTest extends AbstractWebContract {

    @LocalServerPort
    int port;

    WebTestClient client;

    @BeforeEach
    void client() {
        client = WebTestClient.bindToServer().baseUrl("http://localhost:" + port).build();
    }

    @Override
    protected Reply get(String path) {
        return reply(client.get().uri(URI.create("http://localhost:" + port + path)).exchange().expectBody().returnResult());
    }

    @Override
    protected Reply post(String path, String contentType, byte[] body) {
        return reply(client.post().uri(URI.create("http://localhost:" + port + path))
            .contentType(MediaType.parseMediaType(contentType)).bodyValue(body).exchange().expectBody().returnResult());
    }

    private static Reply reply(EntityExchangeResult<byte[]> result) {
        HttpHeaders headers = new HttpHeaders();
        headers.addAll(result.getResponseHeaders());
        byte[] body = result.getResponseBody();
        return new Reply(result.getStatus().value(), headers, body == null ? new byte[0] : body);
    }

    @Override
    protected void applicationErrorsAreNotCaptured() {
        // Not a registered Datum route: Boot's own error handling answers, in its shape, not ours.
        Reply own = get("/app/boom");
        assertThat(own.status()).isEqualTo(500);
        assertThat(own.json().has("errors")).isFalse();
        assertThat(own.headers().containsHeader("X-Datum-Correlation-Id")).isFalse();
        // The same exception on a registered route is Datum's.
        Reply datum = get("/test/throw/unknown");
        assertThat(datum.status()).isEqualTo(500);
        assertThat(datum.code()).isEqualTo("internal");
    }
}
