package com.argusvane.datum.pdf.web;

import java.net.URI;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.test.web.reactive.server.EntityExchangeResult;
import org.springframework.test.web.reactive.server.WebTestClient;

/** Requests against a random-port server into a {@link Reply}. */
final class FluxTransport {

    private FluxTransport() {
    }

    static Reply send(int port, String method, String path, String contentType, byte[] body, String... headers) {
        WebTestClient client = WebTestClient.bindToServer().baseUrl("http://localhost:" + port).build();
        WebTestClient.RequestBodySpec spec = client.method(HttpMethod.valueOf(method)).uri(URI.create("http://localhost:" + port + path));
        if (contentType != null) {
            spec = spec.header(HttpHeaders.CONTENT_TYPE, contentType);
        }
        for (int i = 0; i + 1 < headers.length; i += 2) {
            spec = (WebTestClient.RequestBodySpec) spec.header(headers[i], headers[i + 1]);
        }
        WebTestClient.RequestHeadersSpec<?> ready = body == null ? spec : spec.bodyValue(body);
        EntityExchangeResult<byte[]> result = ready.exchange().expectBody().returnResult();
        HttpHeaders out = new HttpHeaders();
        out.addAll(result.getResponseHeaders());
        byte[] bytes = result.getResponseBody();
        return new Reply(result.getStatus().value(), out, bytes == null ? new byte[0] : bytes);
    }
}
