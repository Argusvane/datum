package com.argusvane.datum.submissions.web;

import com.argusvane.datum.submissions.spi.SubmissionRequest;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.context.annotation.Bean;
import org.springframework.test.web.reactive.server.WebTestClient;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

/** The reactive twin: an annotated controller takes a {@code SubmissionRequest} parameter on WebFlux. */
@SpringBootTest(classes = {SubmissionsFluxTestApp.class, FluxSubmissionRequestResolverTest.Mine.class},
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
    "spring.main.web-application-type=reactive",
    "datum.forms.locations=classpath:/datum-test-forms/*.json",
    "datum.runtime.warm-up-runs=1"})
class FluxSubmissionRequestResolverTest {

    @TestConfiguration(proxyBeanMethods = false)
    static class Mine {

        @Bean
        Probe applicationProbe() {
            return new Probe();
        }
    }

    @RestController
    static class Probe {

        @PostMapping("/app/whoami")
        String whoami(SubmissionRequest request) {
            return request.contentType() + "|" + (request.remoteAddress() == null ? "?" : "ip") + "|" + (request.principal() == null ? "-" : "p")
                + "|" + request.headers().get("X-Probe");
        }
    }

    @LocalServerPort
    int port;

    @Autowired
    org.springframework.context.ApplicationContext context;

    @Test
    void theParameterCarriesTheViewOfTheRequest() {
        WebTestClient.bindToServer().baseUrl("http://localhost:" + port).build().post().uri("/app/whoami")
            .header("Content-Type", "application/json").header("X-Probe", "one").bodyValue("{}")
            .exchange().expectStatus().isOk().expectBody(String.class).isEqualTo("application/json|ip|p|[one]");
    }
}
