package com.argusvane.datum.examples.webfluxpdf;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.starter.test.AutoConfigureDatum;
import com.argusvane.datum.starter.test.DatumWebTestClient;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.test.web.reactive.server.WebTestClient;

/**
 * springdoc's document of every Datum group lists exactly the routes the configuration enables and none of the
 * switched-off ones. Each capability has its own group ({@code /v3/api-docs/datum-<capability>}); this application
 * has all six on, with some endpoints switched off by property. The routes on WebFlux are router functions, so
 * this also proves the router operations and the group filters agree with the routes that exist.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
    "datum.pdf.signing.ssl-bundle=",
    "spring.ssl.bundle.jks.pdf-signer.keystore.location=",
    "spring.ssl.bundle.jks.pdf-signer.keystore.password=",
    "spring.ssl.bundle.jks.pdf-signer.keystore.type=",
    "datum.pdf.seal.enabled=false",
    "datum.builder.enabled=true",
    "datum.webauthn.enabled=true",
    "datum.webauthn.allow-memory-stores=true",
    "datum.webauthn.rp-id=localhost",
    "datum.webauthn.origins=http://localhost:8080",
    "datum.webauthn.secret=an-example-secret-that-is-at-least-32-bytes-long",
    // The data sources and the PDF verify and certificate routes are off; test and inspect are off by default.
    "datum.web.api.endpoints.data-sources=false",
    "datum.web.api.endpoints.verify=false",
    "datum.web.api.endpoints.certificate=false"})
@AutoConfigureDatum
class OpenApiGroupsTest {

    @LocalServerPort
    int port;

    private DatumWebTestClient datum() {
        return new DatumWebTestClient(WebTestClient.bindToServer().baseUrl("http://localhost:" + port).build());
    }

    @Test
    void everyGroupListsExactlyTheEnabledRoutes() {
        DatumWebTestClient datum = datum();
        assertThat(datum.apiDocOperations("forms")).containsExactlyInAnyOrder(
            "GET /api/forms/{key}/definition", "GET /api/forms/{key}/translations",
            // the builder's writes share the forms paths: the forms group lists them beside the reads
            "POST /api/forms", "PUT /api/forms/{key}", "PUT /api/forms/{key}/translations");
        assertThat(datum.apiDocOperations("submissions")).containsExactlyInAnyOrder("POST /api/submissions", "POST /api/submissions/validate");
        assertThat(datum.apiDocOperations("ui")).containsExactlyInAnyOrder("POST /api/forms", "PUT /api/forms/{key}", "PUT /api/forms/{key}/translations");
        assertThat(datum.apiDocOperations("pdf")).containsExactlyInAnyOrder("POST /api/pdf", "POST /api/pdf/fill", "POST /api/pdf/sign");
        assertThat(datum.apiDocOperations("tsa")).containsExactlyInAnyOrder("GET /tsa/certificate", "GET /tsa/certificates", "POST /tsa");
        assertThat(datum.apiDocOperations("webauthn")).containsExactlyInAnyOrder(
            "DELETE /api/webauthn/passkeys/{id}", "GET /api/webauthn/passkeys", "POST /api/webauthn/challenge",
            "POST /api/webauthn/passkeys/{id}/check", "POST /api/webauthn/passkeys/{id}/check-challenge", "POST /api/webauthn/register");
    }

    @Test
    void theSwitchedOffRoutesAreNotInTheDocumentsAndNotMapped() {
        DatumWebTestClient datum = datum();
        assertThat(datum.apiDocPaths("forms")).doesNotContain("/api/data-sources/{id}");
        assertThat(datum.apiDocPaths("pdf")).doesNotContain("/api/pdf/verify", "/api/server/certificate");
        assertThat(datum.apiDocPaths("submissions")).doesNotContain("/api/submissions/test", "/api/inspect");
        // Not mapped at all: the router's own 404, with none of the typed errors a Datum handler would answer.
        for (String path : new String[] {"/api/data-sources/colours", "/api/server/certificate", "/api/submissions/test", "/api/inspect"}) {
            datum.get(path).expectStatus().isNotFound().expectBody(String.class).value(body -> assertThat(body == null ? "" : body).doesNotContain("\"errors\""));
        }
        datum.post("/api/pdf/verify", com.argusvane.datum.starter.test.DatumTestForms.json("{}")).expectStatus()
            .value(status -> assertThat(status).isIn(404, 405));
    }
}
