package com.argusvane.datum.pdf.web;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;

@SpringBootTest(classes = PdfWebTestApp.class, webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = {"spring.main.web-application-type=reactive",
        "datum.web.api.endpoints.pdf=true", "datum.web.api.endpoints.fill=true", "datum.web.api.endpoints.sign=true", "datum.web.api.endpoints.verify=true", "datum.web.api.endpoints.certificate=true"})
class FluxPdfTest extends PdfWebContract {

    @LocalServerPort
    int port;

    @Autowired
    PdfWebTestBeans.Probe probe;

    @Override
    protected PdfWebTestBeans.Probe probe() {
        return probe;
    }

    @Override
    protected Reply send(String method, String path, String contentType, byte[] body, String... headers) {
        return FluxTransport.send(port, method, path, contentType, body, headers);
    }
}
