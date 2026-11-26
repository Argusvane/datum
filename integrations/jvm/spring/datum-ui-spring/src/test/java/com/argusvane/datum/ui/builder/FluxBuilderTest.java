package com.argusvane.datum.ui.builder;

import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.context.annotation.Import;

/** The builder's writes on WebFlux, over a real Netty server so the body is read from the wire. */
@SpringBootTest(classes = BuilderTestApp.class, webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
    "spring.main.web-application-type=reactive",
    "datum.builder.enabled=true", "datum.web.api.endpoints.definition=true",
    "datum.builder.max-definition-size=256KB"})
@Import(AppRoutes.class)
class FluxBuilderTest extends BuilderWebContract {

    @LocalServerPort
    int port;

    @Override
    protected Http.Reply send(String method, String path, byte[] body, String... headers) {
        return Http.server(port, method, path, body, headers);
    }
}
