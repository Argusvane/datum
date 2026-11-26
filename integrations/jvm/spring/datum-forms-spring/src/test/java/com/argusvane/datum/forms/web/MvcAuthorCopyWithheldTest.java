package com.argusvane.datum.forms.web;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.test.web.servlet.MockMvc;

@SpringBootTest(classes = FormsMvcTestApp.class, properties = {
    "datum.web.api.endpoints.definition=true",
    "forms-test.builder=false",
    "spring.main.web-application-type=servlet"})
@AutoConfigureMockMvc
class MvcAuthorCopyWithheldTest extends AuthorCopyWithheldContract {

    @Autowired
    MockMvc mvc;

    @Override
    protected Reply get(String path, String... headers) {
        return MvcTransport.get(mvc, path, headers);
    }
}
