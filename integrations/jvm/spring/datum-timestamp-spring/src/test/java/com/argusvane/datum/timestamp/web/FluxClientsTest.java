package com.argusvane.datum.timestamp.web;

import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;

@SpringBootTest(classes = TsaFluxTestApp.class, webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
    "datum.tsa.enabled=true", "datum.tsa.allow-memory-stores=true",
    "datum.tsa.access=clients",
    "datum.tsa.signer.self-signed=true",
    "datum.tsa.clients[0]=c2931b824fd8a71cdfbdb5a24c62eaed4b9d2dde904e70cc4f1a29378bdb9102",
    "datum.tsa.clients[1]=second=a8a39bf8877a0b30461bbeeff9ba6aaee34de0700852894ce07d75c889c5c365",
    "spring.main.web-application-type=reactive"})
class FluxClientsTest extends ClientsContract {

    @LocalServerPort
    int port;

    @Override
    protected Reply send(String method, String path, byte[] body, String... headers) {
        return FluxTransport.send(port, method, path, body, headers);
    }
}
