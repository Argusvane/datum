package com.argusvane.datum.pdf.web;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;

/** Another API base path, with sign and the certificate switched off: those routes are simply absent. */
@SpringBootTest(classes = PdfWebTestApp.class, webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = {"spring.main.web-application-type=reactive", "datum.web.api.path=/ops/api", "datum.web.api.endpoints.pdf=true", "datum.web.api.endpoints.fill=true", "datum.web.api.endpoints.verify=true",
        "datum.web.api.endpoints.sign=false",
        "datum.web.api.endpoints.certificate=false"})
class FluxPdfOperatorTest extends PdfWebContract {

    @LocalServerPort
    int port;

    @Autowired
    PdfWebTestBeans.Probe probe;

    @Override
    protected PdfWebTestBeans.Probe probe() {
        return probe;
    }

    @Override
    protected String api() {
        return "/ops/api";
    }

    @Override
    protected boolean signAndCertificateOff() {
        return true;
    }

    @Override
    protected Reply send(String method, String path, String contentType, byte[] body, String... headers) {
        return FluxTransport.send(port, method, path, contentType, body, headers);
    }
}
