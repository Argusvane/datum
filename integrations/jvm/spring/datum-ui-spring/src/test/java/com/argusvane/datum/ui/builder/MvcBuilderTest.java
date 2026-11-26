package com.argusvane.datum.ui.builder;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.test.web.servlet.MockMvc;

/** The builder's writes on Spring MVC. */
@SpringBootTest(classes = BuilderTestApp.class, properties = {
    "spring.main.web-application-type=servlet",
    "datum.builder.enabled=true", "datum.web.api.endpoints.definition=true",
    "datum.builder.max-definition-size=256KB"})
@AutoConfigureMockMvc
@Import(AppRoutes.class)
class MvcBuilderTest extends BuilderWebContract {

    @Autowired
    MockMvc mvc;

    @Override
    protected Http.Reply send(String method, String path, byte[] body, String... headers) {
        return Http.mvc(mvc, method, path, body, headers);
    }
}
