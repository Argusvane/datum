package com.argusvane.datum.timestamp.web;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.test.web.servlet.MockMvc;

@SpringBootTest(classes = {TsaMvcTestApp.class, TimeSourceTestBeans.class}, properties = {
    "datum.tsa.enabled=true", "datum.tsa.allow-memory-stores=true",
    "datum.tsa.access=open",
    "datum.tsa.signer.self-signed=true",
    "spring.main.web-application-type=servlet"})
@AutoConfigureMockMvc
class MvcTimeUnavailableTest extends TimeUnavailableContract {

    @Autowired
    MockMvc mvc;

    @Override
    protected Reply send(String method, String path, byte[] body, String... headers) {
        return MvcTransport.send(mvc, method, path, body, headers);
    }
}
