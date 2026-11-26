package com.argusvane.datum.timestamp.web;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.test.web.servlet.MockMvc;

@SpringBootTest(classes = TsaMvcTestApp.class, properties = {
    "datum.tsa.enabled=true", "datum.tsa.allow-memory-stores=true",
    "datum.tsa.access=clients",
    "datum.tsa.signer.self-signed=true",
    "datum.tsa.clients[0]=c2931b824fd8a71cdfbdb5a24c62eaed4b9d2dde904e70cc4f1a29378bdb9102",
    "datum.tsa.clients[1]=second=a8a39bf8877a0b30461bbeeff9ba6aaee34de0700852894ce07d75c889c5c365",
    "spring.main.web-application-type=servlet"})
@AutoConfigureMockMvc
class MvcClientsTest extends ClientsContract {

    @Autowired
    MockMvc mvc;

    @Override
    protected Reply send(String method, String path, byte[] body, String... headers) {
        return MvcTransport.send(mvc, method, path, body, headers);
    }
}
