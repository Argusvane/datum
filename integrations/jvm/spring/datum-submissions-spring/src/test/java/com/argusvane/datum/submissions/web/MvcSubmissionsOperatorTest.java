package com.argusvane.datum.submissions.web;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.test.web.servlet.MockMvc;

/** The dry-run and inspect endpoints switched on, under another API base path. */
@SpringBootTest(classes = SubmissionsMvcTestApp.class, properties = {
    "spring.main.web-application-type=servlet",
    "datum.web.api.endpoints.submissions=true",
    "datum.web.api.endpoints.validate=true",
    "datum.forms.locations=classpath:/datum-test-forms/*.json",
    "datum.runtime.warm-up-runs=1",
    "datum.runtime.validation.concurrency=1",
    "datum.runtime.validation.wait=0s",
    "datum.web.api.max-body-size=16KB",
    "datum.web.api.path=/ops/api",
    "datum.web.api.endpoints.test=true",
    "datum.web.api.endpoints.inspect=true"})
@AutoConfigureMockMvc
class MvcSubmissionsOperatorTest extends SubmissionsWebContract {

    @Autowired
    MockMvc mvc;

    @Autowired
    WebTestBeans.Probe probe;

    @Override
    protected WebTestBeans.Probe probe() {
        return probe;
    }

    @Override
    protected String api() {
        return "/ops/api";
    }

    @Override
    protected boolean operatorEndpoints() {
        return true;
    }

    @Override
    protected Reply send(String method, String path, String contentType, byte[] body, String... headers) {
        return MvcTransport.send(mvc, method, path, contentType, body, headers);
    }
}
