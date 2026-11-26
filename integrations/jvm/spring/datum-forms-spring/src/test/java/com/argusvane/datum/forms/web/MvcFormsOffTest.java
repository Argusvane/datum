package com.argusvane.datum.forms.web;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.test.web.servlet.MockMvc;

@SpringBootTest(classes = FormsMvcTestApp.class, properties = {
    "spring.main.web-application-type=servlet"})
@AutoConfigureMockMvc
class MvcFormsOffTest extends FormsOffContract {

    @Autowired
    MockMvc mvc;

    @Override
    protected Reply get(String path, String... headers) {
        return MvcTransport.get(mvc, path, headers);
    }
}
