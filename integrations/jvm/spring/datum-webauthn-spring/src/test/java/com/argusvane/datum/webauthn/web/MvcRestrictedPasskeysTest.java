package com.argusvane.datum.webauthn.web;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;

/** Visitors may not make passkeys and nobody may at a form (the Test context still may). */
@MvcApp
@TestPropertySource(locations = "classpath:passkeys-main.properties", properties = {"datum.webauthn.allow-memory-stores=true",
    "datum.webauthn.anonymous=false", "datum.webauthn.register-at-submit=false"})
class MvcRestrictedPasskeysTest extends RestrictedContract {

    @Autowired
    MockMvc mvc;

    @Override
    protected Reply send(String method, String path, byte[] body, String... headers) {
        return MvcTransport.send(mvc, method, path, body, headers);
    }
}
