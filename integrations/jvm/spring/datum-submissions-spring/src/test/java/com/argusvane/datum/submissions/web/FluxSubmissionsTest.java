package com.argusvane.datum.submissions.web;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;

@SpringBootTest(classes = SubmissionsFluxTestApp.class, webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
    "spring.main.web-application-type=reactive",
    "datum.web.api.endpoints.submissions=true",
    "datum.web.api.endpoints.validate=true",
    "datum.forms.locations=classpath:/datum-test-forms/*.json",
    "datum.runtime.warm-up-runs=1",
    "datum.runtime.validation.concurrency=1",
    "datum.runtime.validation.wait=0s",
    "datum.web.api.max-body-size=16KB"})
class FluxSubmissionsTest extends SubmissionsWebContract {

    @LocalServerPort
    int port;

    @Autowired
    WebTestBeans.Probe probe;

    @Override
    protected WebTestBeans.Probe probe() {
        return probe;
    }

    @Override
    protected Reply send(String method, String path, String contentType, byte[] body, String... headers) {
        return FluxTransport.send(port, method, path, contentType, body, headers);
    }
}
