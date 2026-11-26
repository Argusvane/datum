package com.argusvane.datum.webauthn.web;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;

/** datum.webauthn.enabled=false: no endpoint, no beans. */
@MvcApp
@TestPropertySource(properties = "datum.webauthn.enabled=false")
class MvcOffPasskeysTest extends OffContract {

    @Autowired
    MockMvc mvc;

    @Override
    protected Reply send(String method, String path, byte[] body, String... headers) {
        return MvcTransport.send(mvc, method, path, body, headers);
    }
}
