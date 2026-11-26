package com.argusvane.datum.webauthn.web;

import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.TestPropertySource;

/** The passkey endpoints on WebFlux over the SQL stores (H2, the shipped migration): nothing acknowledged. */
@FluxApp
@TestPropertySource(locations = "classpath:passkeys-main.properties")
@Import(JdbcTestBeans.class)
class FluxJdbcPasskeysTest extends JdbcPasskeysContract {

    @LocalServerPort
    int port;

    @Override
    protected Reply send(String method, String path, byte[] body, String... headers) {
        return FluxTransport.send(port, method, path, body, headers);
    }
}
