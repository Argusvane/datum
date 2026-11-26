package com.argusvane.datum.forms.web;

import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;

@SpringBootTest(classes = {FormsFluxTestApp.class, DefinitionCustomizerBeans.class}, webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = {
        "datum.web.api.endpoints.definition=true",
        "spring.main.web-application-type=reactive"})
class FluxDefinitionCustomizerTest extends DefinitionCustomizerContract {

    @LocalServerPort
    int port;

    @Override
    protected Reply get(String path, String... headers) {
        return FluxTransport.get(port, path, headers);
    }

    @Override
    protected java.util.Locale noHeaderLocale() {
        return java.util.Locale.getDefault();
    }
}
