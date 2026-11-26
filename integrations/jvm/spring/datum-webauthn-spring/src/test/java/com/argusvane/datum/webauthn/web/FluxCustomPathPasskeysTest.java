package com.argusvane.datum.webauthn.web;

import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.test.context.TestPropertySource;

/** datum.webauthn.path=/passkeys-v2/: every expectation holds at the new path. */
@FluxApp
@TestPropertySource(locations = "classpath:passkeys-main.properties", properties = {"datum.webauthn.allow-memory-stores=true",
    "datum.webauthn.path=/passkeys-v2/"})
class FluxCustomPathPasskeysTest extends CustomPathContract {

    @LocalServerPort
    int port;

    @Override
    protected Reply send(String method, String path, byte[] body, String... headers) {
        return FluxTransport.send(port, method, path, body, headers);
    }
}
