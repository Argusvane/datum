package com.argusvane.datum.springweb.mvc;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.springweb.contract.AbstractWebContract;
import com.argusvane.datum.springweb.support.Failures;
import java.net.URI;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.HttpHeaders;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders;

@SpringBootTest(classes = MvcTestApp.class, properties = {
    "datum.web.assets.enabled=true",
    "datum.web.api.max-body-size=1KB",
    "datum.web.assets.omit-features=journeys",
    "spring.main.web-application-type=servlet"})
@AutoConfigureMockMvc
class MvcWebTest extends AbstractWebContract {

    @Autowired
    MockMvc mvc;

    @Override
    protected Reply get(String path) {
        try {
            return reply(mvc.perform(MockMvcRequestBuilders.get(URI.create(path))).andReturn().getResponse());
        } catch (Exception e) {
            throw new AssertionError(e);
        }
    }

    @Override
    protected Reply post(String path, String contentType, byte[] body) {
        try {
            return reply(mvc.perform(MockMvcRequestBuilders.post(URI.create(path)).contentType(contentType).content(body)).andReturn().getResponse());
        } catch (Exception e) {
            throw new AssertionError(e);
        }
    }

    private static Reply reply(MockHttpServletResponse response) {
        HttpHeaders headers = new HttpHeaders();
        response.getHeaderNames().forEach(name -> headers.addAll(name, response.getHeaders(name)));
        if (response.getContentType() != null) {
            headers.set(HttpHeaders.CONTENT_TYPE, response.getContentType());
        }
        return new Reply(response.getStatus(), headers, response.getContentAsByteArray());
    }

    @Override
    protected void applicationErrorsAreNotCaptured() {
        // The application's @RestControllerAdvice answers its own controller...
        Reply own = get("/app/boom");
        assertThat(own.status()).isEqualTo(418);
        assertThat(own.text()).isEqualTo("app handled");
        // ...while the same exception type from a Datum controller goes through the Datum mapping (the
        // application's advice has lower precedence and the Datum advice is limited to Datum controllers).
        assertThat(Failures.of("unknown")).isInstanceOf(IllegalStateException.class);
        Reply datum = get("/test/throw/unknown");
        assertThat(datum.status()).isEqualTo(500);
        assertThat(datum.code()).isEqualTo("internal");
    }
}
