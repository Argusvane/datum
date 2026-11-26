package com.argusvane.datum.webauthn.web;

import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.test.context.TestPropertySource;

/** datum.webauthn.enabled=false: no endpoint, no beans. */
@FluxApp
@TestPropertySource(properties = "datum.webauthn.enabled=false")
class FluxOffPasskeysTest extends OffContract {

    @LocalServerPort
    int port;

    @Override
    protected Reply send(String method, String path, byte[] body, String... headers) {
        return FluxTransport.send(port, method, path, body, headers);
    }
}
