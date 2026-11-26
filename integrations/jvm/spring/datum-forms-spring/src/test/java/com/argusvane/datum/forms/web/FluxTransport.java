package com.argusvane.datum.forms.web;

import java.net.URI;
import org.springframework.http.HttpHeaders;
import org.springframework.test.web.reactive.server.EntityExchangeResult;
import org.springframework.test.web.reactive.server.WebTestClient;

/** GETs against a random-port server into a {@link Reply}. */
final class FluxTransport {

    private FluxTransport() {
    }

    static Reply get(int port, String path, String... headers) {
        return send(port, "GET", path, headers);
    }

    static Reply send(int port, String method, String path, String... headers) {
        WebTestClient client = WebTestClient.bindToServer().baseUrl("http://localhost:" + port).build();
        WebTestClient.RequestHeadersSpec<?> spec = client.method(org.springframework.http.HttpMethod.valueOf(method))
            .uri(URI.create("http://localhost:" + port + path));
        for (int i = 0; i + 1 < headers.length; i += 2) {
            spec = spec.header(headers[i], headers[i + 1]);
        }
        EntityExchangeResult<byte[]> result = spec.exchange().expectBody().returnResult();
        HttpHeaders out = new HttpHeaders();
        out.addAll(result.getResponseHeaders());
        byte[] body = result.getResponseBody();
        return new Reply(result.getStatus().value(), out, body == null ? new byte[0] : body);
    }
}
