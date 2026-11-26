package com.argusvane.datum.webauthn.web;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;

/** The passkey endpoints on Spring MVC over the SQL stores (H2, the shipped migration): nothing acknowledged. */
@MvcApp
@TestPropertySource(locations = "classpath:passkeys-main.properties")
@Import(JdbcTestBeans.class)
class MvcJdbcPasskeysTest extends JdbcPasskeysContract {

    @Autowired
    MockMvc mvc;

    @Override
    protected Reply send(String method, String path, byte[] body, String... headers) {
        return MvcTransport.send(mvc, method, path, body, headers);
    }
}
