package com.argusvane.datum.forms.web;

import java.net.URI;
import org.springframework.http.HttpHeaders;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders;

/** GETs through MockMvc into a {@link Reply}. */
final class MvcTransport {

    private MvcTransport() {
    }

    static Reply get(MockMvc mvc, String path, String... headers) {
        return send(mvc, "GET", path, headers);
    }

    static Reply send(MockMvc mvc, String method, String path, String... headers) {
        try {
            MockHttpServletRequestBuilder request = MockMvcRequestBuilders.request(org.springframework.http.HttpMethod.valueOf(method), URI.create(path));
            for (int i = 0; i + 1 < headers.length; i += 2) {
                request.header(headers[i], headers[i + 1]);
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
}
