package com.argusvane.datum.ui.builder;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.test.web.servlet.MockMvc;

/** Spring MVC, builder off (the default). */
@SpringBootTest(classes = BuilderTestApp.class, properties = {"spring.main.web-application-type=servlet",
    "datum.web.api.endpoints.definition=true"})
@AutoConfigureMockMvc
class MvcBuilderOffTest extends BuilderOffContract {

    @Autowired
    MockMvc mvc;

    @Override
    protected Http.Reply send(String method, String path, byte[] body, String... headers) {
        return Http.mvc(mvc, method, path, body, headers);
    }
}
