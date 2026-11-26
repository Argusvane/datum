package com.argusvane.datum.pdf.web;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.pdf.verify.Certificates;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.Set;
import java.util.TreeSet;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;

/**
 * What the PDF endpoints answer, the same on both stacks. A subclass supplies the application (the MVC controllers on
 * MockMvc, the router function on a random-port Netty server); this class holds the expectations so the stacks cannot
 * drift apart. The program behind is {@code ScriptedPdfRuntime} (canned kernel answers), so every status is reachable
 * without the engine. Default configuration: every endpoint on, a 16 KB JSON cap, a 2 KB PDF cap.
 */
abstract class PdfWebContract {

    protected static final String JSON = "application/json";

    /** Any method, with a Content-Type (or null), a body (or null) and request headers as name, value pairs. */
    protected abstract Reply send(String method, String path, String contentType, byte[] body, String... headers);

    protected abstract PdfWebTestBeans.Probe probe();

    /** The API base the application was started with. */
    protected String api() {
        return "/api";
    }

    /** Whether {@code sign} and {@code certificate} are switched off in this configuration. */
    protected boolean signAndCertificateOff() {
        return false;
    }

    @BeforeEach
    void reset() {
        probe().reset();
    }

    protected Reply post(String path, String body, String... headers) {
        return send("POST", api() + path, JSON, body.getBytes(StandardCharsets.UTF_8), headers);
    }

    protected static String print(String extra) {
        return "{\"document\":" + PdfWebTestBeans.ENVELOPE + extra + "}";
    }

    // ------------------------------------------------------------------ POST /pdf

    @Test
    void pdfAnswersThePdfWithItsHeaders() {
        Reply reply = post("/pdf", print(",\"layoutId\":\"copy\""));
        assertThat(reply.status()).as(reply.text()).isEqualTo(200);
        assertThat(reply.headers().getContentType().toString()).isEqualTo("application/pdf");
        assertThat(reply.headers().getFirst("Content-Disposition")).isEqualTo("attachment; filename=\"intake-copy.pdf\"");
        assertThat(reply.headers().getFirst("Cache-Control")).isEqualTo("no-store");
        assertThat(reply.headers().getFirst("X-Page-Count")).isEqualTo("1");
        assertThat(reply.headers().getFirst("X-Datum-Layout")).isEqualTo("copy");
        // The preset is on and the answers were never submitted: the throwaway test certificate seals them.
        assertThat(reply.headers().getFirst("X-Signed-By")).contains("Datum test seal");
        assertThat(reply.headers().getFirst("X-Signature-Field")).isNotBlank();
        assertThat(reply.headers().getFirst("X-Timestamped")).isEqualTo("false");
        assertThat(reply.text()).startsWith("%PDF-");
        assertThat(probe().requests("document")).singleElement()
            .satisfies(sent -> assertThat(sent.path("values").path("name").asString()).as("the sanitized values print").isEqualTo("x"));
    }

    @Test
    void pdfRefusesInTheOrderTheFacadeDecides() {
        assertThat(send("POST", api() + "/pdf", "text/plain", "{}".getBytes(StandardCharsets.UTF_8)).status()).isEqualTo(415);
        Reply big = send("POST", api() + "/pdf", JSON, new byte[16 * 1024 + 1]);
        assertThat(big.status()).isEqualTo(413);
        assertThat(big.code()).isEqualTo("bad_document");
        Reply notJson = post("/pdf", "{not json");
        assertThat(notJson.status()).isEqualTo(400);
        assertThat(notJson.code()).isEqualTo("bad_document");
        assertThat(post("/pdf", "{\"ZZSECRETZZ\":1}").status()).isEqualTo(400);
        assertThat(post("/pdf", "{\"ZZSECRETZZ\":1}").text()).doesNotContain("ZZSECRETZZ");
        // The application's security (the chain, written with DatumRequestMatchers.pdf()) refuses too.
        Reply denied = post("/pdf", print(""), "X-Deny", "submit");
        assertThat(denied.status()).isEqualTo(403);
        assertThat(denied.code()).isEqualTo("access.denied");
        assertThat(post("/pdf", print(""), "X-Deny", "read").status()).isEqualTo(403);
        assertThat(probe().requests()).as("nothing was printed").isEmpty();
    }

    @Test
    void aThrottledRequestIs429WithRetryAfter() {
        probe().throttled = java.time.Duration.ofSeconds(30);
        Reply reply = post("/pdf", print(""));
        assertThat(reply.status()).isEqualTo(429);
        assertThat(reply.code()).isEqualTo("flood");
        assertThat(reply.headers().getFirst("Retry-After")).isEqualTo("30");
    }

    /** The JSON routes the address limit counts: print, fill and, where it is on, sign (its own MVC controller). */
    private String[] jsonRoutes() {
        return signAndCertificateOff() ? new String[] {"/pdf", "/pdf/fill"} : new String[] {"/pdf", "/pdf/fill", "/pdf/sign"};
    }

    @Test
    void aBodyThatDoesNotParseIsCountedByTheAddressLimitAndOverItIs429Unread() {
        assertThat(post("/pdf", "{").status()).isEqualTo(400);
        assertThat(send("POST", api() + "/pdf/verify", "application/pdf", "not a pdf".getBytes(StandardCharsets.UTF_8)).status()).isEqualTo(400);
        assertThat(probe().addressesCounted).as("counted before the parse, on a print and a verify").hasSize(2);
        assertThat(send("POST", api() + "/pdf", "text/plain", "{".getBytes(StandardCharsets.UTF_8)).status()).isEqualTo(415);
        assertThat(probe().addressesCounted).as("415 before the address limit").hasSize(2);
        probe().addressThrottled = java.time.Duration.ofSeconds(9);
        for (String path : jsonRoutes()) {
            Reply reply = post(path, "{");
            assertThat(reply.status()).as(path + " " + reply.text()).isEqualTo(429);
            assertThat(reply.code()).isEqualTo("flood");
            assertThat(reply.headers().getFirst("Retry-After")).isEqualTo("9");
        }
        Reply verify = send("POST", api() + "/pdf/verify", "application/pdf", "not a pdf".getBytes(StandardCharsets.UTF_8));
        assertThat(verify.status()).as(verify.text()).isEqualTo(429);
        assertThat(verify.code()).isEqualTo("flood");
        assertThat(probe().addressesCounted).as("a refused request is not counted").hasSize(2);
        assertThat(probe().requests()).as("nothing was printed").isEmpty();
    }

    @Test
    void aRequestOverTheAddressLimitIs429FloodEvenWhenItsBodyIsOverTheCap() {
        probe().addressThrottled = java.time.Duration.ofSeconds(9);
        // Over the cap: 413 if the body were read first, 429 because the address is asked before the read.
        for (String path : jsonRoutes()) {
            Reply reply = send("POST", api() + path, JSON, new byte[16 * 1024 + 1]);
            assertThat(reply.status()).as(path + " " + reply.text()).isEqualTo(429);
            assertThat(reply.code()).isEqualTo("flood");
        }
        Reply verify = send("POST", api() + "/pdf/verify", "application/pdf", new byte[2049]);
        assertThat(verify.status()).as(verify.text()).isEqualTo(429);
        assertThat(verify.code()).isEqualTo("flood");
        assertThat(probe().addressesCounted).as("a refused request is not counted").isEmpty();
        assertThat(probe().requests()).as("nothing was printed").isEmpty();
    }

    @Test
    void answersTheServerDoesNotAcceptAre422WithTheirFindings() {
        probe().refuse = true;
        Reply reply = post("/pdf", print(""));
        assertThat(reply.status()).isEqualTo(422);
        assertThat(reply.json().path("errors").path(0).path("code").asString()).isEqualTo("required");
        assertThat(probe().requests()).isEmpty();
    }

    @Test
    void aServerThatCannotPrintIs503() {
        probe().down = true;
        Reply reply = post("/pdf", print(""));
        assertThat(reply.status()).isEqualTo(503);
        assertThat(reply.code()).isEqualTo("server.unavailable");
    }

    /**
     * A PDF run that gave no answer (the module trapped) is the server's failure, never a judgement of the answers: 503
     * with the run's own code, no {@code Retry-After} (only {@code server.busy} carries it), no sandbox text and no
     * {@code field} member, on a print and on a verify alike.
     */
    @Test
    void aPdfRunThatFailedIs503WithItsCodeAndNoRetryAfter() {
        probe().runFails = true;
        Reply print = post("/pdf", print(""));
        assertThat(print.status()).as(print.text()).isEqualTo(503);
        assertThat(print.code()).isEqualTo("wasm.execution_error");
        assertThat(print.headers().getFirst("Retry-After")).isNull();
        assertThat(print.text()).doesNotContain("SECRET", "\"field\"");
        Reply verify = send("POST", api() + "/pdf/verify", "application/pdf", "%PDF-1.7\n%%EOF\n".getBytes(StandardCharsets.US_ASCII));
        assertThat(verify.status()).as(verify.text()).isEqualTo(503);
        assertThat(verify.code()).isEqualTo("wasm.execution_error");
        assertThat(verify.headers().getFirst("Retry-After")).isNull();
    }

    /**
     * The application's {@code PdfResultValidator} on the wire: errors are a 422 with the errors body (the first
     * error's code, every error in order, the field kept), another kind is its own status, a throwing validator a 500 that
     * names nothing of the cause; a refused PDF is never sealed, never sent and announces no {@code PdfRenderedEvent}.
     */
    @Test
    void aRefusingResultValidatorIs422WithItsErrorsAndNoEvent() {
        Reply ok = post("/pdf", print(",\"layoutId\":\"copy\""));
        assertThat(ok.status()).as(ok.text()).isEqualTo(200);
        assertThat(probe().events).as("a PDF that leaves is announced").hasSize(1);
        probe().events.clear();

        probe().verdict = "refuse";
        Reply refused = post("/pdf", print(",\"layoutId\":\"copy\""));
        assertThat(refused.status()).as(refused.text()).isEqualTo(422);
        assertThat(refused.code()).isEqualTo("pdf.tooManyPages");
        assertThat(refused.json().path("errors").path(0).path("field").asString()).isEqualTo("pages");
        assertThat(refused.json().path("errors").path(1).path("code").asString()).isEqualTo("pdf.tooLarge");
        assertThat(refused.headers().getFirst("X-Signed-By")).as("no seal on a refused PDF").isNull();
        assertThat(refused.text()).doesNotStartWith("%PDF-");

        probe().verdict = "forbid";
        Reply forbidden = post("/pdf", print(",\"layoutId\":\"copy\""));
        assertThat(forbidden.status()).isEqualTo(403);
        assertThat(forbidden.code()).isEqualTo("pdf.tenant");

        probe().verdict = "throw";
        Reply failed = post("/pdf", print(",\"layoutId\":\"copy\""));
        assertThat(failed.status()).isEqualTo(500);
        assertThat(failed.code()).isEqualTo("internal");
        assertThat(failed.text()).doesNotContain("secret").doesNotContain("page policy");
        assertThat(probe().events).as("no refused or failed PDF is announced").isEmpty();
    }

    @Test
    void aWrongMethodIs405() {
        Reply reply = send("GET", api() + "/pdf", null, null);
        assertThat(reply.status()).isEqualTo(405);
        assertThat(reply.headers().getFirst("Allow")).contains("POST");
    }

    // ------------------------------------------------------------------ POST /pdf/fill

    @Test
    void fillWritesTheAnswersIntoATemplateLayout() {
        String template = Base64.getEncoder().encodeToString("%PDF-1.7 a form".getBytes(StandardCharsets.US_ASCII));
        Reply reply = post("/pdf/fill", print(",\"layoutId\":\"form-a\",\"template\":{\"data\":\"" + template + "\"}"));
        assertThat(reply.status()).as(reply.text()).isEqualTo(200);
        assertThat(reply.headers().getContentType().toString()).isEqualTo("application/pdf");
        assertThat(reply.headers().getFirst("Content-Disposition")).isEqualTo("attachment; filename=\"intake-form-a-filled.pdf\"");
        assertThat(reply.headers().getFirst("X-Signed-By")).as("a posted template is never sealed with the server's key").isNull();
        assertThat(probe().requests("document").get(0).path("template").path("data").asString()).isEqualTo(template);
    }

    @Test
    void fillNeedsAnExistingTemplateLayout() {
        assertThat(post("/pdf/fill", print("")).status()).as("no layoutId").isEqualTo(400);
        Reply generated = post("/pdf/fill", print(",\"layoutId\":\"copy\""));
        assertThat(generated.status()).isEqualTo(400);
        assertThat(generated.code()).isEqualTo("layout.notTemplate");
        Reply missing = post("/pdf/fill", print(",\"layoutId\":\"nope\""));
        assertThat(missing.status()).isEqualTo(404);
        assertThat(missing.code()).isEqualTo("layout.notFound");
    }

    // ------------------------------------------------------------------ POST /pdf/sign

    @Test
    void signAlwaysSeals() {
        if (signAndCertificateOff()) {
            assertThat(post("/pdf/sign", print("")).status()).isEqualTo(404);
            return;
        }
        Reply reply = post("/pdf/sign", print(",\"layoutId\":\"copy\""));
        assertThat(reply.status()).as(reply.text()).isEqualTo(200);
        assertThat(reply.headers().getContentType().toString()).isEqualTo("application/pdf");
        assertThat(reply.headers().getFirst("Content-Disposition")).isEqualTo("attachment; filename=\"intake-copy-signed.pdf\"");
        assertThat(reply.headers().getFirst("X-Signed-By")).contains("Datum test seal");
        assertThat(reply.headers().getFirst("X-Timestamped")).isEqualTo("false");
        assertThat(probe().requests("complete").size()).isEqualTo(1);
        assertThat(post("/pdf/sign", print(""), "X-Deny", "submit").status()).isEqualTo(403);
    }

    // ------------------------------------------------------------------ POST /pdf/verify

    @Test
    void verifyAnswersTheReportOfAPostedPdf() {
        Reply reply = send("POST", api() + "/pdf/verify", "application/pdf", "%PDF-1.7\n%%EOF\n".getBytes(StandardCharsets.US_ASCII));
        assertThat(reply.status()).as(reply.text()).isEqualTo(200);
        assertThat(reply.headers().getContentType().toString()).startsWith(JSON);
        assertThat(reply.headers().getFirst("Cache-Control")).isEqualTo("no-store");
        assertThat(reply.json().has("signatures")).isTrue();
        assertThat(reply.json().path("sha256").asString()).hasSize(64);
    }

    @Test
    void verifyRefusesWhatIsNotAPdfOrIsTooBig() {
        assertThat(send("POST", api() + "/pdf/verify", JSON, "{}".getBytes(StandardCharsets.UTF_8)).status()).isEqualTo(415);
        Reply big = send("POST", api() + "/pdf/verify", "application/pdf", new byte[2049]);
        assertThat(big.status()).isEqualTo(413);
        assertThat(big.code()).isEqualTo("bad_document");
        Reply text = send("POST", api() + "/pdf/verify", "application/pdf", "hello".getBytes(StandardCharsets.US_ASCII));
        assertThat(text.status()).isEqualTo(400);
        assertThat(text.code()).isEqualTo("pdf.notAPdf");
        probe().throttled = java.time.Duration.ofSeconds(5);
        assertThat(send("POST", api() + "/pdf/verify", "application/pdf", "%PDF-1.7".getBytes(StandardCharsets.US_ASCII)).status()).isEqualTo(429);
    }

    // ------------------------------------------------------------------ GET /server/certificate

    @Test
    void theServersChainIsServedAsPem() {
        if (signAndCertificateOff()) {
            assertThat(send("GET", api() + "/server/certificate", null, null).status()).isEqualTo(404);
            return;
        }
        Reply reply = send("GET", api() + "/server/certificate", null, null);
        assertThat(reply.status()).isEqualTo(200);
        assertThat(reply.headers().getContentType().toString()).startsWith("application/x-pem-file");
        assertThat(reply.headers().getFirst("Content-Disposition")).contains("server-certificate.pem");
        assertThat(com.argusvane.datum.timestamp.PemCertificates.read(reply.text())).hasSize(2);
        // HEAD answers as GET does on both stacks (the WebFlux router maps it by hand).
        Reply head = send("HEAD", api() + "/server/certificate", null, null);
        assertThat(head.status()).isEqualTo(200);
        assertThat(head.headers().getContentType().toString()).startsWith("application/x-pem-file");
        assertThat(head.headers().getFirst("Content-Disposition")).contains("server-certificate.pem");
    }

    @Test
    void aNumberJsonCannotWriteBackIs400BeforeTheDryRun() {
        // 1e999 re-serialises as the string "Infinity" and a text field would print it: the receiver's own 400 stands here.
        String envelope = PdfWebTestBeans.ENVELOPE.replace("\"<b>x</b>\"", "1e999");
        Reply reply = post("/pdf", "{\"document\":" + envelope + "}");
        assertThat(reply.status()).as(reply.text()).isEqualTo(400);
        assertThat(reply.text()).contains("outside the range of a number");
        assertThat(probe().requests()).isEmpty();
    }

    // ------------------------------------------------------------------ OpenAPI

    protected Set<String> documentedPaths() {
        Reply doc = send("GET", "/v3/api-docs/datum-pdf", null, null);
        assertThat(doc.status()).isEqualTo(200);
        Set<String> paths = new TreeSet<>();
        doc.json().path("paths").propertyNames().forEach(paths::add);
        return paths;
    }

    @Test
    void theOpenApiDocumentListsExactlyTheEnabledRoutes() {
        Set<String> expected = new TreeSet<>(Set.of(api() + "/pdf", api() + "/pdf/fill", api() + "/pdf/verify"));
        if (!signAndCertificateOff()) {
            expected.add(api() + "/pdf/sign");
            expected.add(api() + "/server/certificate");
        }
        assertThat(documentedPaths()).isEqualTo(expected);
    }

    @Test
    void theDocumentedOperationsCarryTheirResponsesAndDatumsCommonErrors() {
        JsonNode doc = send("GET", "/v3/api-docs/datum-pdf", null, null).json();
        JsonNode pdf = doc.at("/paths/" + api().replace("/", "~1") + "~1pdf/post");
        assertThat(pdf.isMissingNode()).isFalse();
        assertThat(pdf.get("operationId").asString()).isEqualTo("renderPdf");
        assertThat(pdf.get("tags").get(0).asString()).isEqualTo("datum-pdf");
        assertThat(pdf.get("requestBody").isMissingNode()).isFalse();
        assertThat(pdf.get("responses").propertyNames()).contains("200", "400", "403", "404", "413", "415", "422", "429", "503");
        assertThat(pdf.at("/responses/200/content").propertyNames()).contains("application/pdf");
        assertThat(pdf.get("description").asString()).as("the PDF reply's headers, on both stacks")
            .contains("X-Page-Count", "X-Datum-Layout", "X-Datum-Pdf-Theme", "X-Signed-By", "X-Signature-Field", "X-Timestamped");
        assertThat(doc.at("/components/schemas").propertyNames()).contains("ErrorsBody");
    }

    /**
     * The verify report's schema (from the shared catalog): the 200 names it, and it carries the members this host
     * adds, the trust policy at the top and each trusted signature's {@code trustedAt}.
     */
    @Test
    void theVerifyReportIsDocumentedWithItsTrustPolicyAndTrustedAt() {
        JsonNode doc = send("GET", "/v3/api-docs/datum-pdf", null, null).json();
        JsonNode verify = doc.at("/paths/" + api().replace("/", "~1") + "~1pdf~1verify/post/responses/200/content/application~1json/schema");
        assertThat(verify.path("$ref").asString()).isEqualTo("#/components/schemas/PdfVerifyReport");
        JsonNode report = doc.at("/components/schemas/PdfVerifyReport/properties");
        assertThat(report.at("/trustPolicy/$ref").asString()).isEqualTo("#/components/schemas/PdfTrustPolicySummary");
        // Optional in the shared catalog: another host's report without it conforms.
        assertThat(doc.at("/components/schemas/PdfVerifyReport/required").valueStream().map(JsonNode::asString).toList())
            .contains("sha256", "bytes", "signatures").doesNotContain("trustPolicy");
        assertThat(report.at("/signatures/items/$ref").asString()).isEqualTo("#/components/schemas/PdfSignatureVerdict");
        assertThat(report.at("/warnings/items/type").asString()).isEqualTo("string");
        assertThat(doc.at("/components/schemas/PdfTrustPolicySummary/properties/revocationChecking/type").asString()).isEqualTo("boolean");
        assertThat(doc.at("/components/schemas/PdfSignatureVerdict/properties/trustedAt/type").asString()).isEqualTo("string");
    }

    /** The document holds to the library's endpoint catalog (integrations/jvm/README.md "Libraries and bindings"), on this stack. */
    @Test
    void theDocumentHoldsToTheEndpointCatalog() {
        JsonNode doc = send("GET", "/v3/api-docs/datum-pdf", null, null).json();
        java.util.Map<com.argusvane.datum.web.openapi.DatumEndpointCatalog.Base, String> bases = java.util.Map.of(com.argusvane.datum.web.openapi.DatumEndpointCatalog.Base.API, api());
        assertThat(com.argusvane.datum.web.openapi.DatumEndpointCatalog.differences(doc, bases)).isEmpty();
        assertThat(com.argusvane.datum.web.openapi.DatumEndpointCatalog.missing(doc, "pdf", bases, endpoint -> !signAndCertificateOff()
            || !(endpoint.operationId().equals("signPdf") || endpoint.operationId().equals("serverCertificate")))).isEmpty();
    }
}
