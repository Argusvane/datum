package com.argusvane.datum.forms.web;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.test.web.servlet.MockMvc;

@SpringBootTest(classes = {FormsMvcTestApp.class, DefinitionCustomizerBeans.class}, properties = {
    "datum.web.api.endpoints.definition=true",
    "spring.main.web-application-type=servlet"})
@AutoConfigureMockMvc
class MvcDefinitionCustomizerTest extends DefinitionCustomizerContract {

    @Autowired
    MockMvc mvc;

    @Override
    protected Reply get(String path, String... headers) {
        return MvcTransport.get(mvc, path, headers);
    }

    @Override
    protected java.util.Locale noHeaderLocale() {
        // MockMvc's request answers English when no Accept-Language is sent; Tomcat answers the JVM default.
        return java.util.Locale.ENGLISH;
    }
}
