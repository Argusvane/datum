package com.argusvane.datum.webauthn.web;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;

/** datum.webauthn.path=/passkeys-v2/: every expectation holds at the new path. */
@MvcApp
@TestPropertySource(locations = "classpath:passkeys-main.properties", properties = {"datum.webauthn.allow-memory-stores=true",
    "datum.webauthn.path=/passkeys-v2/"})
class MvcCustomPathPasskeysTest extends CustomPathContract {

    @Autowired
    MockMvc mvc;

    @Override
    protected Reply send(String method, String path, byte[] body, String... headers) {
        return MvcTransport.send(mvc, method, path, body, headers);
    }
}
