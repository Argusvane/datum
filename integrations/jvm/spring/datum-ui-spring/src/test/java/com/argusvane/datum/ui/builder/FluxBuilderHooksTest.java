package com.argusvane.datum.ui.builder;

import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;

@SpringBootTest(classes = {BuilderTestApp.class, BuilderHookBeans.class}, webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
    "spring.main.web-application-type=reactive",
    "datum.builder.enabled=true", "datum.web.api.endpoints.definition=true"})
class FluxBuilderHooksTest extends BuilderHooksContract {

    @LocalServerPort
    int port;

    @Override
    protected Http.Reply send(String method, String path, byte[] body, String... headers) {
        return Http.server(port, method, path, body, headers);
    }
}
