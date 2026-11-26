package com.argusvane.datum.timestamp.web;

import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;

@SpringBootTest(classes = TsaFluxTestApp.class, webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
    "spring.main.web-application-type=reactive"})
class FluxOffTest extends OffContract {

    @LocalServerPort
    int port;

    @Override
    protected Reply send(String method, String path, byte[] body, String... headers) {
        return FluxTransport.send(port, method, path, body, headers);
    }
}
