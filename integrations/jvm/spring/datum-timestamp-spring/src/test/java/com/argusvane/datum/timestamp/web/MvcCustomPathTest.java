package com.argusvane.datum.timestamp.web;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.test.web.servlet.MockMvc;

@SpringBootTest(classes = TsaMvcTestApp.class, properties = {
    "datum.tsa.enabled=true", "datum.tsa.allow-memory-stores=true", "datum.tsa.access=open", "datum.tsa.signer.self-signed=true", "datum.tsa.path=/stamp/",
    "datum.tsa.retired-certificates=classpath:fixtures/tsa.cert.pem",
    "datum.tsa.clients[0]=c2931b824fd8a71cdfbdb5a24c62eaed4b9d2dde904e70cc4f1a29378bdb9102",
    "spring.main.web-application-type=servlet"})
@AutoConfigureMockMvc
class MvcCustomPathTest extends CustomPathContract {

    @Autowired
    MockMvc mvc;

    @Override
    protected Reply send(String method, String path, byte[] body, String... headers) {
        return MvcTransport.send(mvc, method, path, body, headers);
    }
}
