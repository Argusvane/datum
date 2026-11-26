package com.argusvane.datum.ui.builder;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.test.web.servlet.MockMvc;

@SpringBootTest(classes = {BuilderTestApp.class, BuilderHookBeans.class}, properties = {
    "spring.main.web-application-type=servlet",
    "datum.builder.enabled=true", "datum.web.api.endpoints.definition=true"})
@AutoConfigureMockMvc
class MvcBuilderHooksTest extends BuilderHooksContract {

    @Autowired
    MockMvc mvc;

    @Override
    protected Http.Reply send(String method, String path, byte[] body, String... headers) {
        return Http.mvc(mvc, method, path, body, headers);
    }
}
