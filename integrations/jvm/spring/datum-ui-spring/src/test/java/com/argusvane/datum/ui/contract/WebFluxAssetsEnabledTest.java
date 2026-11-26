package com.argusvane.datum.ui.contract;

import com.argusvane.datum.ui.UiTestApp;
import java.net.URI;
import org.junit.jupiter.api.BeforeEach;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.http.HttpHeaders;
import org.springframework.test.web.reactive.server.EntityExchangeResult;
import org.springframework.test.web.reactive.server.WebTestClient;

/** WebFlux on a real (random-port) Netty server, builder switched on. */
@SpringBootTest(classes = UiTestApp.class, webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = {"spring.main.web-application-type=reactive", "datum.builder.enabled=true", "datum.web.assets.enabled=true"})
class WebFluxAssetsEnabledTest extends AbstractAssetsContract {

    @LocalServerPort
    int port;

    WebTestClient client;

    @BeforeEach
    void client() {
        client = WebTestClient.bindToServer().baseUrl("http://localhost:" + port)
            .codecs(codecs -> codecs.defaultCodecs().maxInMemorySize(32 * 1024 * 1024)).build();
    }

    @Override
    protected boolean builderEnabled() {
        return true;
    }

    @Override
    protected Reply get(String path) {
        EntityExchangeResult<byte[]> result = client.get().uri(URI.create("http://localhost:" + port + path))
            .exchange().expectBody().returnResult();
        HttpHeaders headers = new HttpHeaders();
        headers.addAll(result.getResponseHeaders());
        byte[] body = result.getResponseBody();
        return new Reply(result.getStatus().value(), headers, body == null ? new byte[0] : body);
    }
}
