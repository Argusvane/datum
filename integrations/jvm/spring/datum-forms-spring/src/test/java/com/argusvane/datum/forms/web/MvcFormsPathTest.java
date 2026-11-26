package com.argusvane.datum.forms.web;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.test.web.servlet.MockMvc;

@SpringBootTest(classes = FormsMvcTestApp.class, properties = {
    "datum.forms.data-sources.timeout=300ms",
    "datum.web.api.endpoints.definition=true",
    "datum.web.api.endpoints.data-sources=true",
    "datum.web.api.path=/v1/datum/",
    "spring.main.web-application-type=servlet"})
@AutoConfigureMockMvc
class MvcFormsPathTest extends FormsWebContract {

    @Autowired
    MockMvc mvc;

    @org.springframework.beans.factory.annotation.Autowired
    com.argusvane.datum.forms.FakeGuestRuntime runtime;

    @Override
    protected com.argusvane.datum.forms.FakeGuestRuntime runtime() {
        return runtime;
    }

    @Override
    protected Reply send(String method, String path, String... headers) {
        return MvcTransport.send(mvc, method, path, headers);
    }

    @Override
    protected Reply get(String path, String... headers) {
        return MvcTransport.get(mvc, path, headers);
    }

    @Override
    protected String api() {
        return "/v1/datum";
    }
}
