package com.argusvane.datum.webauthn.web;

import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.test.context.TestPropertySource;

/** The passkey endpoints on WebFlux over the in-memory stores (acknowledged). */
@FluxApp
@TestPropertySource(locations = "classpath:passkeys-main.properties", properties = "datum.webauthn.allow-memory-stores=true")
class FluxPasskeysTest extends PasskeysContract {

    @LocalServerPort
    int port;

    @Override
    protected Reply send(String method, String path, byte[] body, String... headers) {
        return FluxTransport.send(port, method, path, body, headers);
    }
}
