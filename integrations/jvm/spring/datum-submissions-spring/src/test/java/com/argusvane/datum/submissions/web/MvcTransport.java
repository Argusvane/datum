package com.argusvane.datum.submissions.web;

import java.net.URI;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders;

/** Requests through MockMvc into a {@link Reply}. */
final class MvcTransport {

    private MvcTransport() {
    }

    static Reply send(MockMvc mvc, String method, String path, String contentType, byte[] body, String... headers) {
        try {
            MockHttpServletRequestBuilder request = MockMvcRequestBuilders.request(HttpMethod.valueOf(method), URI.create(path));
            if (contentType != null) {
                request.header(HttpHeaders.CONTENT_TYPE, contentType);
            }
            if (body != null) {
                request.content(body);
            }
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
