package com.argusvane.datum.timestamp.web;

import jakarta.servlet.http.Cookie;
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

    static Reply send(MockMvc mvc, String method, String path, byte[] body, String... headers) {
        try {
            MockHttpServletRequestBuilder request = MockMvcRequestBuilders.request(HttpMethod.valueOf(method), URI.create(path));
            for (int i = 0; i + 1 < headers.length; i += 2) {
                if (headers[i].equalsIgnoreCase("Cookie")) {
                    // MockMvc does not parse the Cookie header into getCookies(); a servlet container does.
                    for (String pair : headers[i + 1].split(";")) {
                        String[] nameValue = pair.strip().split("=", 2);
                        request.cookie(new Cookie(nameValue[0], nameValue.length > 1 ? nameValue[1] : ""));
                    }
                } else {
                    request.header(headers[i], headers[i + 1]);
                }
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
}
