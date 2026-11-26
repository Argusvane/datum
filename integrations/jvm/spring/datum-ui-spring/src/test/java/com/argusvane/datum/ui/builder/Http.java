package com.argusvane.datum.ui.builder;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.web.reactive.server.EntityExchangeResult;
import org.springframework.test.web.reactive.server.WebTestClient;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** Requests with a body through MockMvc or a random-port server, answered as one stack-neutral {@link Reply}. */
final class Http {

    private static final JsonMapper JSON = JsonMapper.builder().build();

    private Http() {
    }

    /** A reply. */
    record Reply(int status, HttpHeaders headers, byte[] body) {

        String text() {
            return new String(body, StandardCharsets.UTF_8);
        }

        JsonNode json() {
            return JSON.readTree(body);
        }

        /** The code of the first error entry. */
        String code() {
            return json().get("errors").get(0).get("code").asString();
        }

        String header(String name) {
            return headers.getFirst(name);
        }
    }

    /** Headers are name, value pairs. A null body sends none. */
    static Reply mvc(MockMvc mvc, String method, String path, byte[] body, String... headers) {
        try {
            MockHttpServletRequestBuilder request = MockMvcRequestBuilders.request(HttpMethod.valueOf(method), URI.create(path));
            for (int i = 0; i + 1 < headers.length; i += 2) {
                request.header(headers[i], headers[i + 1]);
            }
            if (body != null) {
                request.content(body);
            }
            MockHttpServletResponse response = mvc.perform(request).andReturn().getResponse();
            HttpHeaders out = new HttpHeaders();
            response.getHeaderNames().forEach(name -> out.addAll(name, response.getHeaders(name)));
            if (response.getContentType() != null) {
                out.set(HttpHeaders.CONTENT_TYPE, response.getContentType());
            }
            return new Reply(response.getStatus(), out, response.getContentAsByteArray());
        } catch (Exception e) {
            throw new AssertionError(e);
        }
    }

    static Reply server(int port, String method, String path, byte[] body, String... headers) {
        WebTestClient client = WebTestClient.bindToServer().baseUrl("http://localhost:" + port).build();
        WebTestClient.RequestBodySpec spec = client.method(HttpMethod.valueOf(method)).uri(URI.create("http://localhost:" + port + path));
        for (int i = 0; i + 1 < headers.length; i += 2) {
            spec = spec.header(headers[i], headers[i + 1]);
        }
        EntityExchangeResult<byte[]> result = (body != null ? spec.bodyValue(body) : spec).exchange().expectBody().returnResult();
        HttpHeaders out = new HttpHeaders();
        out.addAll(result.getResponseHeaders());
        byte[] answer = result.getResponseBody();
        return new Reply(result.getStatus().value(), out, answer == null ? new byte[0] : answer);
    }
}
