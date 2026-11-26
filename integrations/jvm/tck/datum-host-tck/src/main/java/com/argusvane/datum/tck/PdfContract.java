package com.argusvane.datum.tck;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;

/**
 * The server PDF routes over the fixture form with the REAL PDF program: posted answers print (and, when the host
 * holds a signing key, are sealed with a throwaway test certificate, never the server's key), refused answers do
 * not print, sign seals, the server's chain is public, verify reads what the host made, and the refusals come in
 * order (404 {@code layout.notFound}, 415, 400 {@code pdf.notAPdf}).
 * The signing tests are assumptions on {@link HostTarget#pdfSigning()}: without a key they report as skipped, never
 * as passed. The per-route test is an assumption on {@link HostTarget#pdfBindings()}.
 */
public interface PdfContract extends HostContract {

    private Reply post(String path, String body) {
        return http().postJson(target().api(path), body);
    }

    private static String decoded(Reply reply, String header) {
        return reply.header(header).map(value -> URLDecoder.decode(value, StandardCharsets.UTF_8)).orElse(null);
    }

    @Test
    @Order(1401)
    default void postedAnswersPrintAsAPdf() {
        Reply reply = post("/pdf", TckFixtures.wrapped(TckFixtures.envelope("CTL-01")));
        assertThat(reply.status()).as(reply.toString()).isEqualTo(200);
        assertThat(reply.bytesAsText()).startsWith("%PDF-");
        assertThat(reply.mediaType()).isEqualTo("application/pdf");
        assertThat(reply.header("X-Page-Count")).hasValueSatisfying(count -> assertThat(Integer.parseInt(count)).isGreaterThanOrEqualTo(1));
        Reply report = http().post(target().api("/pdf/verify"), "application/pdf", reply.body());
        assertThat(report.status()).as(report.toString()).isEqualTo(200);
        assertThat(report.json().path("signatures").isArray()).as(report.toString()).isTrue();
    }

    @Test
    @Order(1402)
    default void answersTheServerRefusesAreNotPrinted() {
        Reply reply = post("/pdf", TckFixtures.wrapped(TckFixtures.envelope("CTL-02")));
        assertThat(reply.status()).as(reply.toString()).isEqualTo(422);
        assertThat(reply.code()).isEqualTo("required");
    }

    @Test
    @Order(1403)
    default void signSealsAndTheServersChainIsPublic() {
        // An assumption, not an early return: without a key the test reports as skipped, never as a pass.
        assumeTrue(target().pdfSigning(), "the host holds no signing key (datum.tck.pdf-signing)");
        Reply signed = post("/pdf/sign", TckFixtures.wrapped(TckFixtures.envelope("CTL-01")));
        assertThat(signed.status()).as(signed.toString()).isEqualTo(200);
        assertThat(decoded(signed, "X-Signed-By")).isNotBlank();
        assertThat(signed.bytesAsText()).startsWith("%PDF-");

        Reply chain = http().get(target().api("/server/certificate"));
        assertThat(chain.status()).as(chain.toString()).isEqualTo(200);
        assertThat(chain.text()).contains("-----BEGIN CERTIFICATE-----");
    }

    @Test
    @Order(1404)
    default void fillNeedsATemplateLayoutAndTheRefusalsComeInOrder() {
        String document = TckFixtures.envelope("CTL-01").toString();
        Reply noLayout = post("/pdf/fill", "{\"document\":" + document + ",\"layoutId\":\"datum-tck-no-such-layout\"}");
        assertThat(noLayout.status()).as(noLayout.toString()).isEqualTo(404);
        assertThat(noLayout.code()).isEqualTo("layout.notFound");
        assertThat(http().post(target().api("/pdf"), "text/plain", "{}".getBytes(StandardCharsets.UTF_8)).status()).isEqualTo(415);
        assertThat(http().post(target().api("/pdf/verify"), "application/json", "{}".getBytes(StandardCharsets.UTF_8)).status()).isEqualTo(415);
        Reply notPdf = http().post(target().api("/pdf/verify"), "application/pdf", "hello".getBytes(StandardCharsets.UTF_8));
        assertThat(notPdf.status()).as(notPdf.toString()).isEqualTo(400);
        assertThat(notPdf.code()).isEqualTo("pdf.notAPdf");
    }

    @Test
    @Order(1405)
    default void postedAnswersAreSealedWithATestCertificateNeverTheServersKey() {
        assumeTrue(target().pdfSigning(), "the host holds no signing key (datum.tck.pdf-signing)");
        Reply reply = post("/pdf", TckFixtures.wrapped(TckFixtures.envelope("CTL-01")));
        assertThat(reply.status()).as(reply.toString()).isEqualTo(200);
        // The answers were posted, not submitted: the server's key does not vouch for them.
        assertThat(decoded(reply, "X-Signed-By")).contains("Datum test seal");
        assertThat(decoded(reply, "X-Signature-Field")).isNotBlank();
        Reply report = http().post(target().api("/pdf/verify"), "application/pdf", reply.body());
        assertThat(report.status()).as(report.toString()).isEqualTo(200);
        JsonNode signatures = report.json().path("signatures");
        assertThat(signatures).hasSize(1);
        assertThat(signatures.path(0).path("intact").asBoolean()).as(signatures.toString()).isTrue();
    }

    @Test
    @Order(1406)
    default void twoRoutesOnOneHostGetEachRoutesCatalogPdfTheme() {
        assumeTrue(target().pdfBindings(), "the host routes " + TckFixtures.FORM_B + " to a binding whose PDF theme is the kit's "
            + TckFixtures.PDF_THEME_ID + " and " + TckFixtures.FORM + " to one with another (datum.tck.pdf-bindings)");
        Reply host = http().get(target().baseUrl() + target().assetsPath() + "/host.json");
        assertThat(host.status()).as(host.toString()).isEqualTo(200);
        JsonNode bindings = host.json().path("bindings");
        assertThat(bindings.isObject()).as("host.json publishes a bindings table: " + host).isTrue();
        String themeA = pdfThemeOf(bindings, TckFixtures.FORM);
        String themeB = pdfThemeOf(bindings, TckFixtures.FORM_B);
        assertThat(themeA).as("the catalog gives the route " + TckFixtures.FORM + " a PDF theme: " + bindings).isNotNull();
        assertThat(themeB).as("the catalog gives the route " + TckFixtures.FORM_B + " a PDF theme: " + bindings).isNotNull();
        assertThat(themeA).as("both routes resolve to one PDF theme: configure one fixture form with another binding").isNotEqualTo(themeB);
        assertThat(themeB).as("the route " + TckFixtures.FORM_B + " resolves to the kit's PDF theme: route it to a binding whose PDF theme is "
            + TckFixtures.PDF_THEME_ID + ", supplied from " + TckFixtures.PDF_THEME).isEqualTo(TckFixtures.PDF_THEME_ID);
        for (String[] route : new String[][] {{TckFixtures.FORM, themeA}, {TckFixtures.FORM_B, themeB}}) {
            Reply reply = post("/pdf", TckFixtures.wrapped(TckFixtures.envelope(route[0], TckFixtures.VERSION, TckFixtures.controlValues("CTL-01"))));
            assertThat(reply.status()).as("the PDF of " + route[0] + ": " + reply).isEqualTo(200);
            assertThat(reply.bytesAsText()).startsWith("%PDF-");
            assertThat(decoded(reply, "X-Datum-Pdf-Theme")).as("X-Datum-Pdf-Theme of " + route[0]).isEqualTo(route[1]);
            // What the PDF was drawn under, not what the header says: the kit's theme draws its text in PDF_THEME_TEXT.
            boolean drawn = PdfColours.setsFillColour(reply.body(), TckFixtures.PDF_THEME_TEXT);
            if (TckFixtures.PDF_THEME_ID.equals(route[1])) {
                assertThat(drawn).as("the PDF of " + route[0] + " is drawn under " + TckFixtures.PDF_THEME_ID + " (fill colour "
                    + TckFixtures.PDF_THEME_TEXT + " in its content streams), not only named in X-Datum-Pdf-Theme").isTrue();
            } else {
                assertThat(drawn).as("the PDF of " + route[0] + " carries " + TckFixtures.PDF_THEME_ID + "'s text colour, but its route's PDF theme is "
                    + route[1]).isFalse();
            }
        }
    }

    /** The PDF theme {@code host.json}'s {@code bindings} gives a form route: its binding's catalog entry (else the default's). */
    private static String pdfThemeOf(JsonNode bindings, String formKey) {
        JsonNode routed = bindings.path("routes").path(formKey);
        String binding = routed.isString() ? routed.asString() : bindings.path("default").asString("");
        for (JsonNode entry : bindings.path("catalog")) {
            if (binding.equals(entry.path("id").asString())) {
                return entry.path("pdfTheme").isString() ? entry.path("pdfTheme").asString() : null;
            }
        }
        return null;
    }
}
