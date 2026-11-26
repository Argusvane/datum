package com.argusvane.datum.submissions.web;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import com.argusvane.datum.submissions.spi.SubmissionRequest;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

/** An application controller takes a {@code SubmissionRequest} parameter, built by the one servlet rule. */
@SpringBootTest(classes = {SubmissionsMvcTestApp.class, MvcSubmissionRequestResolverTest.Mine.class}, properties = {
    "spring.main.web-application-type=servlet",
    "datum.forms.locations=classpath:/datum-test-forms/*.json",
    "datum.runtime.warm-up-runs=1"})
@AutoConfigureMockMvc
class MvcSubmissionRequestResolverTest {

    @TestConfiguration(proxyBeanMethods = false)
    static class Mine {

        @org.springframework.context.annotation.Bean
        Probe applicationProbe() {
            return new Probe();
        }
    }

    @RestController
    static class Probe {

        @PostMapping("/app/whoami")
        String whoami(SubmissionRequest request) {
            return request.contentType() + "|" + request.remoteAddress() + "|" + (request.principal() == null ? "-" : request.principal().getName())
                + "|" + request.headers().get("X-Probe");
        }
    }

    @Autowired
    MockMvc mvc;

    @Test
    void theParameterCarriesTheContentTypeHeadersRemoteAddressAndPrincipal() throws Exception {
        String answer = mvc.perform(post("/app/whoami").contentType("application/json").header("X-Probe", "one").header("X-Probe", "two")
                .with(request -> {
                    request.setRemoteAddr("203.0.113.9");
                    return request;
                })).andReturn().getResponse().getContentAsString();
        assertThat(answer).isEqualTo("application/json|203.0.113.9|tester|[one, two]");
    }

    @Test
    void aRequestWithNoPrincipalReadsAsNull() {
        org.springframework.mock.web.MockHttpServletRequest request = new org.springframework.mock.web.MockHttpServletRequest("POST", "/x");
        request.setContentType("application/json");
        SubmissionRequest view = com.argusvane.datum.submissions.web.mvc.SubmissionRequestResolver.view(request);
        assertThat(view.principal()).isNull();
        assertThat(view.contentType()).isEqualTo("application/json");
    }
}
