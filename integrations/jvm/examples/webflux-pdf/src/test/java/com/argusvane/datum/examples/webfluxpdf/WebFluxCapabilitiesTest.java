package com.argusvane.datum.examples.webfluxpdf;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.starter.test.AutoConfigureDatum;
import com.argusvane.datum.starter.test.DatumTestForms;
import com.argusvane.datum.starter.test.DatumWebTestClient;
import com.argusvane.datum.starter.test.FakeGuestRuntime;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.http.MediaType;
import org.springframework.test.web.reactive.server.WebTestClient;
import tools.jackson.databind.node.ObjectNode;

/**
 * One WebFlux application with every capability on, to prove each answers on the reactive stack: forms, submissions,
 * the UI assets and the builder's writes, PDF, the timestamp server and passkeys. The WebAssembly engine is the
 * fake ({@link AutoConfigureDatum}), so this runs with the unit tests; what the real programs make of a PDF is
 * {@link PdfExampleIT}'s. A route that exists answers something other than 404, and where the answer is knowable
 * (a form, a receipt, the assets, the TSA certificate) the test asserts it.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
    // No key store file in a fresh checkout (the setup script writes it): the PDF routes need no signing key to answer.
    "datum.pdf.signing.ssl-bundle=",
    "spring.ssl.bundle.jks.pdf-signer.keystore.location=",
    "spring.ssl.bundle.jks.pdf-signer.keystore.password=",
    "spring.ssl.bundle.jks.pdf-signer.keystore.type=",
    "datum.pdf.seal.enabled=false",
    "datum.web.throttle.limit=1000",
    "datum.builder.enabled=true",
    "datum.webauthn.enabled=true",
    "datum.webauthn.allow-memory-stores=true",
    "datum.webauthn.rp-id=localhost",
    "datum.webauthn.origins=http://localhost:8080",
    "datum.webauthn.anonymous=true",
    "datum.webauthn.secret=an-example-secret-that-is-at-least-32-bytes-long"})
@AutoConfigureDatum
class WebFluxCapabilitiesTest {

    @LocalServerPort
    int port;

    @Autowired
    FakeGuestRuntime runtime;

    @Autowired
    org.springframework.context.ApplicationContext context;

    WebTestClient client;
    DatumWebTestClient datum;

    @BeforeEach
    void clients() {
        client = WebTestClient.bindToServer().baseUrl("http://localhost:" + port)
            .codecs(codecs -> codecs.defaultCodecs().maxInMemorySize(32 * 1024 * 1024)).build();
        datum = new DatumWebTestClient(client);
    }

    private int statusOfPost(String path, String body) {
        return client.post().uri(path).contentType(MediaType.APPLICATION_JSON).bodyValue(body).exchange().returnResult(byte[].class).getStatus().value();
    }

    private int statusOfGet(String path) {
        return client.get().uri(path).exchange().returnResult(byte[].class).getStatus().value();
    }

    /** Posts a body and asserts the status and the typed error code of the reply (the router's own 404 has no code). */
    private void postRefused(String path, MediaType type, byte[] body, int status, String code) {
        client.post().uri(path).contentType(type).bodyValue(body).exchange()
            .expectStatus().isEqualTo(status).expectBody().jsonPath("$.errors[0].code").isEqualTo(code);
    }

    @Test
    void formsServeTheDefinition() {
        datum.definition("intake").expectStatus().isOk().expectBody().jsonPath("$.id").isEqualTo("intake");
        datum.definition("no-such-form").expectStatus().isNotFound();
        // There is no form list route: which forms exist is the application's own query. The path is the
        // builder's create route (POST), so a GET is a wrong method: 405 with Allow, not a list.
        datum.get("/api/forms").expectStatus().isEqualTo(405).expectHeader().valueEquals("Allow", "POST");
    }

    @Test
    void submissionsAcceptAnAnswerSetAndKeepItInTheApplicationsHandler() {
        ObjectNode envelope = DatumTestForms.envelope("intake", "1",
            "{\"name\":\"Ada Lovelace\",\"email\":\"ada@example.test\",\"request\":\"A copy of my file.\"}");
        datum.submit(envelope).expectStatus().isOk().expectBody().jsonPath("$.reference").isEqualTo("REQ-0001");
        assertThat(runtime.contexts()).isNotEmpty();
        datum.validate(envelope, "page").expectStatus().isOk();
        // Switched off by default: no mapping at all. The application's security comes first: it keeps both
        // routes for form admins, so a visitor is asked to sign in, and the author finds nothing there.
        assertThat(statusOfPost("/api/submissions/test", "{}")).isEqualTo(401);
        for (String path : new String[] {"/api/submissions/test", "/api/inspect"}) {
            assertThat(client.post().uri(path).headers(headers -> headers.setBasicAuth("author", "author")).contentType(MediaType.APPLICATION_JSON)
                .bodyValue("{}").exchange().returnResult(byte[].class).getStatus().value()).as(path).isEqualTo(404);
        }
    }

    @Test
    void theUiServesItsAssetsAndTheBuildersWritesAreThere() {
        datum.get("/datum/assets/host.json").expectStatus().isOk().expectBody().jsonPath("$.assetsBase").exists();
        datum.get("/datum/assets/datum-host.js").expectStatus().isOk();
        // The builder's PUT exists and obeys the application's security (SecurityConfiguration: builderWrites() needs
        // ROLE_FORM_ADMIN). Without it Spring Security refuses before the route: 401 unauthorized for a visitor, 403
        // access.denied for the viewer, in Datum's JSON (DatumServerSecurityResponses).
        String csrf = csrfToken();
        putDefinition(csrf, null).expectStatus().isUnauthorized().expectHeader().valueEquals("WWW-Authenticate", "Basic realm=\"Datum forms\"")
            .expectBody().jsonPath("$.errors[0].code").isEqualTo("unauthorized");
        putDefinition(csrf, "viewer").expectStatus().isForbidden().expectBody().jsonPath("$.errors[0].code").isEqualTo("access.denied");
        // With the role the body is judged: a definition with no root is refused 422, and nothing is stored (the forms are
        // read-only class-path resources).
        putDefinition(csrf, "author").expectStatus().isEqualTo(422);
        // Spring Security's own rule: a write with no CSRF token never reaches Datum. Its refusal is the wire's JSON too
        // (SecurityConfiguration hands the CSRF spec the handler; WebFlux would answer plain text without it).
        client.put().uri("/api/forms/intake").headers(headers -> headers.setBasicAuth("author", "author"))
            .contentType(MediaType.APPLICATION_JSON).bodyValue("{}").exchange().expectStatus().isForbidden()
            .expectHeader().contentTypeCompatibleWith(MediaType.APPLICATION_JSON)
            .expectBody().jsonPath("$.errors[0].code").isEqualTo("access.denied");
        // A wrong password is Spring Security's 401, not an anonymous request.
        client.put().uri("/api/forms/intake").headers(headers -> headers.setBasicAuth("author", "wrong"))
            .cookie("XSRF-TOKEN", csrf).header("X-XSRF-TOKEN", csrf)
            .contentType(MediaType.APPLICATION_JSON).bodyValue("{}").exchange().expectStatus().isUnauthorized();
    }

    /** Any response of the application sets the XSRF-TOKEN cookie (the glue reads it back); the test does the same. */
    private String csrfToken() {
        return client.get().uri("/api/forms/intake/definition").exchange().returnResult(byte[].class).getResponseCookies()
            .getFirst("XSRF-TOKEN").getValue();
    }

    private WebTestClient.ResponseSpec putDefinition(String csrf, String user) {
        return client.put().uri("/api/forms/intake").headers(headers -> {
            if (user != null) {
                headers.setBasicAuth(user, user);
            }
        }).cookie("XSRF-TOKEN", csrf).header("X-XSRF-TOKEN", csrf).contentType(MediaType.APPLICATION_JSON).bodyValue("{}").exchange();
    }

    @Test
    void pdfRoutesAnswerWithTheirOwnTypedErrors() {
        byte[] none = "{}".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        // A body that is not an answer set is refused by the handler (400), not unknown (404) and not a crash (500).
        postRefused("/api/pdf", MediaType.APPLICATION_JSON, none, 400, "bad_request");
        postRefused("/api/pdf/fill", MediaType.APPLICATION_JSON, none, 400, "bad_request");
        // The fake runtime has no PDF program behind sign, so the typed "unavailable" answer is the handler working.
        postRefused("/api/pdf/sign", MediaType.APPLICATION_JSON, none, 503, "server.unavailable");
        // verify reads a PDF, not JSON: its own 415.
        postRefused("/api/pdf/verify", MediaType.APPLICATION_JSON, none, 415, "unsupported_media_type");
        // No key store here: the route answers its own 404 (a typed error), which the router's "no such route" does not.
        client.get().uri("/api/server/certificate").exchange().expectStatus().isNotFound()
            .expectBody().jsonPath("$.errors[0].code").isEqualTo("certificate.notFound");
    }

    @Test
    void theTimestampServerAnswers() {
        datum.get("/tsa/certificate").expectStatus().isOk();
        datum.get("/tsa/certificates").expectStatus().isOk();
        // The handler reads the body type before anything else: JSON is its own 415 (text), not a missing route.
        assertThat(statusOfPost("/tsa", "{}")).isEqualTo(415);
        // This application runs the server with access=open on a loopback-only path: a request of the right type is taken
        // (this client is the loopback) and a body that is no TimeStampReq is answered, never refused 401 nor a 5xx.
        assertThat(client.post().uri("/tsa").contentType(MediaType.parseMediaType("application/timestamp-query")).bodyValue(new byte[] {0x30, 0x00})
            .exchange().returnResult(byte[].class).getStatus().value()).isLessThan(500).isNotEqualTo(401);
    }

    @Test
    void passkeysAnswerWithTheirOwnTypedErrors() {
        // Anonymous callers cannot start a registration: the handler's own 403, with its code.
        postRefused("/api/webauthn/challenge", MediaType.APPLICATION_JSON, "{}".getBytes(java.nio.charset.StandardCharsets.UTF_8), 403, "signing.sign_in");
        client.get().uri("/api/webauthn/passkeys").exchange().expectStatus().isOk().expectBody().jsonPath("$.passkeys").isArray();
    }

    @Test
    void healthAndInfoNameEveryCapability() {
        String health = new String(client.get().uri("/actuator/health").exchange().returnResult(byte[].class).getResponseBodyContent());
        assertThat(health).contains("runtime");
        String info = new String(client.get().uri("/actuator/info").exchange().returnResult(byte[].class).getResponseBodyContent());
        assertThat(info).contains("submissions").contains("pdf");
    }

    @Test
    void theDefaultsDocumentTheDataSourceAndPdfRoutesTheOtherTestSwitchesOff() {
        assertThat(datum.apiDocOperations("forms")).contains("GET /api/data-sources/{id}", "GET /api/forms/{key}/definition");
        assertThat(datum.apiDocOperations("pdf")).containsExactlyInAnyOrder("POST /api/pdf", "POST /api/pdf/fill", "POST /api/pdf/sign",
            "POST /api/pdf/verify", "GET /api/server/certificate");
    }

    @Test
    void anUnmappedPathIsTheRoutersOwn404() {
        // The control for the "answers something other than 404" checks above.
        assertThat(statusOfGet("/api/no-such-route")).isEqualTo(404);
    }

    /**
     * The open TSA path is safe only while the chain refuses everyone but loopback: this client is the loopback and
     * is answered; a request that reaches the same chain without a loopback peer address (the mock connector has none) is
     * refused as access.denied JSON, never a plain-text 403, and a path that is not the TSA's is not this rule's business.
     */
    @Test
    void theChainAnswersTheTimestampServerToLoopbackCallersOnly() {
        datum.get("/tsa/certificate").expectStatus().isOk();

        WebTestClient mock = WebTestClient.bindToApplicationContext(context).build();
        mock.get().uri("/tsa/certificate").exchange().expectStatus().isForbidden()
            .expectHeader().contentTypeCompatibleWith(MediaType.APPLICATION_JSON)
            .expectBody().jsonPath("$.errors[0].code").isEqualTo("access.denied");
        mock.post().uri("/tsa").contentType(MediaType.parseMediaType("application/timestamp-query")).bodyValue(new byte[] {0x30, 0x00})
            .exchange().expectStatus().isForbidden();
        mock.get().uri("/tsabc").exchange().expectStatus().isNotFound();
    }
}
