package com.argusvane.datum.forms.web;

import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;

@SpringBootTest(classes = FormsFluxTestApp.class, webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
    "datum.web.api.endpoints.definition=true",
    "forms-test.builder=false",
    "spring.main.web-application-type=reactive"})
class FluxAuthorCopyWithheldTest extends AuthorCopyWithheldContract {

    @LocalServerPort
    int port;

    @Override
    protected Reply get(String path, String... headers) {
        return FluxTransport.get(port, path, headers);
    }
}
