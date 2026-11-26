package com.argusvane.datum.timestamp.web;

import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;

@SpringBootTest(classes = TsaFluxTestApp.class, webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
    "datum.tsa.enabled=true", "datum.tsa.allow-memory-stores=true", "datum.tsa.access=open", "datum.tsa.signer.self-signed=true", "datum.tsa.path=/stamp/",
    "datum.tsa.retired-certificates=classpath:fixtures/tsa.cert.pem",
    "datum.tsa.clients[0]=c2931b824fd8a71cdfbdb5a24c62eaed4b9d2dde904e70cc4f1a29378bdb9102",
    "spring.main.web-application-type=reactive"})
class FluxCustomPathTest extends CustomPathContract {

    @LocalServerPort
    int port;

    @Override
    protected Reply send(String method, String path, byte[] body, String... headers) {
        return FluxTransport.send(port, method, path, body, headers);
    }

    /** Netty has no declared length for a chunked body: the limit is enforced while reading. */
    @org.junit.jupiter.api.Test
    void aChunkedBodyOverTheLimitIs413() {
        org.springframework.test.web.reactive.server.WebTestClient client = org.springframework.test.web.reactive.server.WebTestClient
            .bindToServer().baseUrl("http://localhost:" + port).build();
        byte[] chunk = new byte[4096];
        byte[] body = client.post().uri("/stamp").header("Content-Type", QUERY)
            .body(reactor.core.publisher.Flux.range(0, 6).map(i -> chunk), byte[].class)
            .exchange().expectStatus().isEqualTo(413).expectBody().returnResult().getResponseBody();
        org.assertj.core.api.Assertions.assertThat(new String(body, java.nio.charset.StandardCharsets.UTF_8)).contains("too large");
    }
}
