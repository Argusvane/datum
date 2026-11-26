package com.argusvane.datum.forms.web;

import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;

@SpringBootTest(classes = FormsFluxTestApp.class, webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
    "datum.forms.data-sources.timeout=300ms",
    "datum.web.api.endpoints.definition=true",
    "datum.web.api.endpoints.data-sources=true",
    "spring.main.web-application-type=reactive"})
class FluxFormsDefaultTest extends FormsWebContract {

    @LocalServerPort
    int port;

    @org.springframework.beans.factory.annotation.Autowired
    com.argusvane.datum.forms.FakeGuestRuntime runtime;

    @Override
    protected com.argusvane.datum.forms.FakeGuestRuntime runtime() {
        return runtime;
    }

    @Override
    protected Reply send(String method, String path, String... headers) {
        return FluxTransport.send(port, method, path, headers);
    }

    @Override
    protected Reply get(String path, String... headers) {
        return FluxTransport.get(port, path, headers);
    }
}
