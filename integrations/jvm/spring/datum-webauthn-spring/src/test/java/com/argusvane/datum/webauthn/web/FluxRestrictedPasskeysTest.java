package com.argusvane.datum.webauthn.web;

import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.test.context.TestPropertySource;

/** Visitors may not make passkeys and nobody may at a form (the Test context still may). */
@FluxApp
@TestPropertySource(locations = "classpath:passkeys-main.properties", properties = {"datum.webauthn.allow-memory-stores=true",
    "datum.webauthn.anonymous=false", "datum.webauthn.register-at-submit=false"})
class FluxRestrictedPasskeysTest extends RestrictedContract {

    @LocalServerPort
    int port;

    @Override
    protected Reply send(String method, String path, byte[] body, String... headers) {
        return FluxTransport.send(port, method, path, body, headers);
    }
}
