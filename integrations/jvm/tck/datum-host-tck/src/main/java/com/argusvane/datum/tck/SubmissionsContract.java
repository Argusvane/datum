package com.argusvane.datum.tck;

import static com.argusvane.datum.tck.TckFixtures.codes;
import static com.argusvane.datum.tck.TckFixtures.delivered;
import static com.argusvane.datum.tck.TckFixtures.envelope;
import static com.argusvane.datum.tck.TckFixtures.goldenErrors;
import static org.assertj.core.api.Assertions.assertThat;

import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * Story one, the receiving routes, over the kit's fixture form with the REAL kernel: the golden control documents
 * (CTL-01 accepted, CTL-02 to CTL-04 refused with the kernel's errors), the journey check, the refusals that come
 * before the kernel is asked (409 stale version, 415, 413, 400, 404), and the submission key: a retry of one attempt
 * answered with the first receipt, another attempt with the same answers a second record, a known key with another
 * document 409 (before the document is judged, so an invalid one is 409 too). A journey check has the one verdict shape
 * ({@code errors} blocking only, {@code notes} for the rest, no null {@code field}) and a strict request (400 for a bare
 * document, a missing scope, a page beside a journey scope, a page check with no page). The host serves {@link TckFixtures#FORM} at version {@link TckFixtures#VERSION} and allows at least 20
 * submissions a minute from one address (the default is 60). Moved here from the Spring submissions example's IT.
 */
public interface SubmissionsContract extends HostContract {

    private Reply submit(String body) {
        return http().postJson(target().api("/submissions"), body);
    }

    @Test
    @Order(1101)
    default void theGoldenValidDocumentIsAcceptedWithADigestAndAReceipt() {
        Reply reply = submit(delivered(envelope("CTL-01")));
        assertThat(reply.status()).as(reply.toString()).isEqualTo(200);
        assertThat(reply.mediaType()).endsWith("json");
        JsonNode body = reply.json();
        assertThat(body.path("status").asString()).isEqualTo("accepted");
        assertThat(body.path("digest").asString()).hasSize(64).matches("[0-9a-f]{64}");
        assertThat(body.path("id").asString()).isNotBlank();
        // A delivery carries its submit attempt's key; without one it is never received.
        Reply bare = submit(envelope("CTL-01").toString());
        assertThat(bare.status()).as(bare.toString()).isEqualTo(400);
        assertThat(bare.code()).isEqualTo("bad_document");
        Reply keyless = submit(TckFixtures.wrapped(envelope("CTL-01")));
        assertThat(keyless.status()).as(keyless.toString()).isEqualTo(400);
        assertThat(keyless.code()).isEqualTo("bad_document");
    }

    @Test
    @Order(1102)
    default void theGoldenInvalidDocumentsAreRefusedWithTheKernelsErrors() {
        for (String control : new String[] {"CTL-02", "CTL-03", "CTL-04"}) {
            Reply reply = submit(delivered(envelope(control)));
            assertThat(reply.status()).as(control + " " + reply).isEqualTo(422);
            assertThat(codes(reply.json().path("errors"))).as(control).isEqualTo(goldenErrors(control));
        }
    }

    @Test
    @Order(1103)
    default void aJourneyCheckAnswersTheSuitesVerdict() {
        for (String control : new String[] {"CTL-01", "CTL-02"}) {
            ObjectNode document = envelope(control);
            ((ObjectNode) document.get("submission")).set("journey", TckFixtures.JSON.readTree("{\"id\":\"main\"}"));
            ObjectNode check = TckFixtures.JSON.createObjectNode();
            check.set("document", document);
            check.put("scope", "journey");
            Reply reply = http().postJson(target().api("/submissions/validate"), check.toString());
            assertThat(reply.status()).as(reply.toString()).isEqualTo(200);
            JsonNode verdict = reply.json();
            assertThat(verdict.path("accepted").asBoolean())
                .as(control).isEqualTo(TckFixtures.golden().path("controls").path(control).path("accepted").asBoolean());
            if (control.equals("CTL-02")) {
                assertThat(codes(verdict.path("errors"))).contains("required@name");
            }
            assertThatTheVerdictHasTheOneWireShape(verdict);
        }
    }

    /**
     * The verdict's one wire shape, on every host: {@code errors} holds only what blocks, each entry {@code {field?, code,
     * message?}} (no severity, and no {@code field} member when the finding names none, never {@code null}); {@code notes}
     * (warnings and info, each with its severity) is left out or a list. Nothing in either list is null-valued.
     */
    private static void assertThatTheVerdictHasTheOneWireShape(JsonNode verdict) {
        assertThat(verdict.propertyNames()).as(verdict.toString()).isSubsetOf("accepted", "errors", "notes");
        assertThat(verdict.path("errors").isArray()).as(verdict.toString()).isTrue();
        for (JsonNode error : verdict.path("errors")) {
            assertThat(error.propertyNames()).as(error.toString()).isSubsetOf("field", "code", "message");
            assertThat(error.path("code").isString()).as(error.toString()).isTrue();
            assertThat(error.has("field") && error.get("field").isNull()).as("field is left out, not null: " + error).isFalse();
        }
        if (verdict.has("notes")) {
            assertThat(verdict.get("notes").isArray()).as(verdict.toString()).isTrue();
            assertThat(verdict.get("notes").size()).as("notes is left out when empty").isPositive();
            for (JsonNode note : verdict.get("notes")) {
                assertThat(note.propertyNames()).as(note.toString()).isSubsetOf("field", "code", "severity", "message");
                assertThat(note.path("severity").asString()).as(note.toString()).isIn("warning", "info");
                assertThat(note.has("field") && note.get("field").isNull()).as("field is left out, not null: " + note).isFalse();
            }
        }
        if (verdict.path("accepted").asBoolean()) {
            assertThat(verdict.path("errors").size()).as("an accepted verdict has no blocking error").isZero();
        }
    }

    /**
     * The request is strict: the body is the {@code {document, ...}} wrapper, {@code scope} is {@code journey} or
     * {@code page}, a page check names its page and a whole-journey check names none ({@code pageId} beside
     * {@code scope: "journey"} is refused, not ignored). Each is a 400, answered before the kernel is asked.
     */
    @Test
    @Order(1107)
    default void aCheckIsStrictAboutItsRequest() {
        ObjectNode document = envelope("CTL-01");
        ((ObjectNode) document.get("submission")).set("journey", TckFixtures.JSON.readTree("{\"id\":\"main\"}"));
        String url = target().api("/submissions/validate");

        Reply bare = http().postJson(url, document.toString());
        assertThat(bare.status()).as("a bare document: " + bare).isEqualTo(400);
        assertThat(bare.code()).isEqualTo("bad_document");

        Reply noScope = http().postJson(url, TckFixtures.wrapped(document));
        assertThat(noScope.status()).as("no scope: " + noScope).isEqualTo(400);

        ObjectNode other = TckFixtures.JSON.createObjectNode();
        other.set("document", document);
        other.put("scope", "all");
        Reply unknownScope = http().postJson(url, other.toString());
        assertThat(unknownScope.status()).as("another scope: " + unknownScope).isEqualTo(400);

        ObjectNode withPage = TckFixtures.JSON.createObjectNode();
        withPage.set("document", document);
        withPage.put("scope", "journey");
        withPage.put("pageId", "p1");
        Reply pageBesideJourney = http().postJson(url, withPage.toString());
        assertThat(pageBesideJourney.status()).as("pageId with scope journey: " + pageBesideJourney).isEqualTo(400);
        assertThat(pageBesideJourney.json().has("accepted")).isFalse();

        ObjectNode noPage = TckFixtures.JSON.createObjectNode();
        noPage.set("document", document);
        noPage.put("scope", "page");
        Reply pageWithoutId = http().postJson(url, noPage.toString());
        assertThat(pageWithoutId.status()).as("scope page with no pageId: " + pageWithoutId).isEqualTo(400);
    }

    @Test
    @Order(1104)
    default void aStaleVersionTheWrongTypeAndAHugeBodyAreRefusedBeforeTheKernelIsAsked() {
        Reply stale = submit(delivered(TckFixtures.envelope("0", TckFixtures.controlValues("CTL-01"))));
        assertThat(stale.status()).as(stale.toString()).isEqualTo(409);
        assertThat(stale.code()).isEqualTo("form.outdated");

        Reply wrongType = http().post(target().api("/submissions"), "text/plain", "{}".getBytes(StandardCharsets.UTF_8));
        assertThat(wrongType.status()).as(wrongType.toString()).isEqualTo(415);
        assertThat(wrongType.code()).isEqualTo("unsupported_media_type");

        Reply huge = submit("{\"document\":{\"pad\":\"" + "x".repeat(1024 * 1024 + 16) + "\"}}");
        assertThat(huge.status()).as(huge.toString()).isEqualTo(413);
        assertThat(huge.code()).isEqualTo("bad_document");
    }

    @Test
    @Order(1105)
    default void notJsonIs400AndAnUnknownFormIs404() {
        Reply notJson = submit("{\"document\":");
        assertThat(notJson.status()).as(notJson.toString()).isEqualTo(400);
        assertThat(notJson.code()).isEqualTo("bad_document");

        ObjectNode unknown = envelope("CTL-01");
        ((ObjectNode) unknown.get("versionContext").get("form")).put("id", "datum-tck-no-such-form");
        Reply missing = submit(delivered(unknown));
        assertThat(missing.status()).as(missing.toString()).isEqualTo(404);
        assertThat(missing.code()).isEqualTo("form.notFound");
    }

    @Test
    @Order(1106)
    default void aSubmitAttemptIsOneRecordByItsKey() {
        // A document no other test sends: the name differs from every golden control and from earlier runs.
        ObjectNode values = TckFixtures.controlValues("CTL-01");
        values.put("name", "Grace Hopper " + Long.toString(System.nanoTime() % 100000, 36));
        String attempt = java.util.UUID.randomUUID().toString();
        String body = delivered(TckFixtures.envelope(TckFixtures.VERSION, values), attempt);
        Reply first = submit(body);
        assertThat(first.status()).as(first.toString()).isEqualTo(200);
        Reply again = submit(body);
        assertThat(again.status()).as(again.toString()).isEqualTo(200);
        assertThat(first.json().path("handled").asBoolean(true)).isFalse();
        assertThat(again.json().path("handled").asBoolean(false)).isTrue();
        // The first receipt again: the handler did not run.
        assertThat(again.json().path("id").asString()).isEqualTo(first.json().path("id").asString());
        assertThat(again.json().path("reference").asString()).isEqualTo(first.json().path("reference").asString());
        assertThat(again.json().path("digest").asString()).isEqualTo(first.json().path("digest").asString());

        // Another person with the same answers: another attempt, another record.
        Reply other = submit(delivered(TckFixtures.envelope(TckFixtures.VERSION, values)));
        assertThat(other.status()).as(other.toString()).isEqualTo(200);
        assertThat(other.json().path("handled").asBoolean(true)).isFalse();
        assertThat(other.json().path("id").asString()).isNotEqualTo(first.json().path("id").asString());

        // The first key with another document: refused, never answered with the first receipt.
        ObjectNode changed = values.deepCopy();
        changed.put("name", values.path("name").asString() + " again");
        Reply conflict = submit(delivered(TckFixtures.envelope(TckFixtures.VERSION, changed), attempt));
        assertThat(conflict.status()).as(conflict.toString()).isEqualTo(409);
        assertThat(conflict.code()).isEqualTo("submission.keyConflict");

        // The first key with a document the form refuses: still the conflict, not the errors. A known key is answered
        // before the document is judged, so every host gives the same answer here.
        ObjectNode failing = values.deepCopy();
        failing.put("code", "abc");
        Reply refused = submit(delivered(TckFixtures.envelope(TckFixtures.VERSION, failing), attempt));
        assertThat(refused.status()).as(refused.toString()).isEqualTo(409);
        assertThat(refused.code()).isEqualTo("submission.keyConflict");
    }
}
