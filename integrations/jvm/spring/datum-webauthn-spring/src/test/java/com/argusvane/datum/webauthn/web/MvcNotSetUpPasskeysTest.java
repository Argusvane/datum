package com.argusvane.datum.webauthn.web;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;

/** No relying-party id or origins: the endpoints answer 503 signing.not_set_up. */
@MvcApp
@TestPropertySource(locations = "classpath:passkeys-main.properties", properties = {"datum.webauthn.allow-memory-stores=true",
    "datum.webauthn.rp-id=", "datum.webauthn.origins="})
class MvcNotSetUpPasskeysTest extends NotSetUpContract {

    @Autowired
    MockMvc mvc;

    @Override
    protected Reply send(String method, String path, byte[] body, String... headers) {
        return MvcTransport.send(mvc, method, path, body, headers);
    }
}
