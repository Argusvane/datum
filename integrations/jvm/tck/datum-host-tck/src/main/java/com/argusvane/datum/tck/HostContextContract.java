package com.argusvane.datum.tck;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.charset.StandardCharsets;
import java.util.Map;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * The server supplies the host context: a host judges the rules that read {@code host.} with
 * values it works out itself from the request, and never with values a client sends. The deployment under test serves the
 * kit's host context fixture ({@link TckFixtures#HOST_CONTEXT_FORM}: {@code name} required, {@code admin_note} required
 * and shown only when {@code host.role = "admin"}), has the dry-run route on, and wires a TEST-ONLY host context provider
 * that, for that form only, answers {@code {"role": <value>}} from the request header {@link TckFixtures#TEST_ROLE_HEADER}
 * when the request carries it, and no context when it does not. The header stands in for what a real host reads from
 * its session; a deployment that takes real submissions never trusts a header a client chooses.
 *
 * <ul>
 *   <li>HCX-01: role {@code admin}, answers {@code {name}}: the check is refused with {@code {field: "admin_note", code:
 *       "required"}} (journey and page scope) and a delivery is 422 with the same error;</li>
 *   <li>HCX-02: role {@code user}: the check and the delivery are accepted;</li>
 *   <li>HCX-03: no header, so no context: accepted, the lenient reading (the dry run lists {@code admin_note} in
 *       {@code visibilitySkipped});</li>
 *   <li>HCX-04: role {@code user} and a document that forges the context ({@code hostContext} on the envelope and on its
 *       submission, a {@code host} answer) and answers {@code admin_note}: still accepted, and the forged answer is not
 *       among the values a delivery stores (the dry run's {@code values}).</li>
 * </ul>
 * Numbered 1950.
 */
public interface HostContextContract extends HostContract {

    private ObjectNode document(ObjectNode values) {
        ObjectNode document = TckFixtures.envelope(TckFixtures.HOST_CONTEXT_FORM, "1", values);
        ((ObjectNode) document.get("submission")).putObject("journey").put("id", "main");
        return document;
    }

    private static ObjectNode nameOnly() {
        ObjectNode values = TckFixtures.JSON.createObjectNode();
        values.put("name", "Ada Lovelace");
        return values;
    }

    private Reply post(String path, String body, String role) {
        Map<String, String> headers = role == null ? Map.of() : Map.of(TckFixtures.TEST_ROLE_HEADER, role);
        return http().send("POST", target().api(path), "application/json", body.getBytes(StandardCharsets.UTF_8), HostTarget.Who.VISITOR, headers);
    }

    private Reply check(ObjectNode document, String scope, String role) {
        ObjectNode body = TckFixtures.JSON.createObjectNode();
        body.set("document", document);
        body.put("scope", scope);
        if ("page".equals(scope)) {
            body.put("pageId", "p1");
        }
        return post("/submissions/validate", body.toString(), role);
    }

    private static JsonNode verdict(Reply reply) {
        assertThat(reply.status()).as(reply.toString()).isEqualTo(200);
        return reply.json();
    }

    private static boolean namesAdminNoteRequired(JsonNode errors) {
        for (JsonNode error : errors) {
            if ("admin_note".equals(error.path("field").asString("")) && "required".equals(error.path("code").asString(""))) {
                return true;
            }
        }
        return false;
    }

    @Test
    @Order(1951)
    default void hcx01AnAdminContextMakesTheAdminNoteRequired() {
        for (String scope : new String[] {"journey", "page"}) {
            JsonNode refused = verdict(check(document(nameOnly()), scope, "admin"));
            assertThat(refused.path("accepted").asBoolean(true)).as(scope + ": " + refused).isFalse();
            assertThat(namesAdminNoteRequired(refused.path("errors"))).as(scope + ": " + refused).isTrue();
        }
        Reply delivery = post("/submissions", TckFixtures.delivered(document(nameOnly())), "admin");
        assertThat(delivery.status()).as(delivery.toString()).isEqualTo(422);
        assertThat(namesAdminNoteRequired(delivery.json().path("errors"))).as(delivery.toString()).isTrue();
    }

    @Test
    @Order(1952)
    default void hcx02AUserContextLeavesTheAdminNoteOut() {
        JsonNode accepted = verdict(check(document(nameOnly()), "journey", "user"));
        assertThat(accepted.path("accepted").asBoolean(false)).as(accepted.toString()).isTrue();
        Reply delivery = post("/submissions", TckFixtures.delivered(document(nameOnly())), "user");
        assertThat(delivery.status()).as(delivery.toString()).isEqualTo(200);
    }

    @Test
    @Order(1953)
    default void hcx03NoContextIsTheLenientReading() {
        JsonNode accepted = verdict(check(document(nameOnly()), "journey", null));
        assertThat(accepted.path("accepted").asBoolean(false)).as(accepted.toString()).isTrue();
        Reply report = post("/submissions/test", TckFixtures.wrapped(document(nameOnly())), null);
        assertThat(report.status()).as(report.toString()).isEqualTo(200);
        assertThat(report.json().path("outcome").asString()).as(report.toString()).isEqualTo("accepted");
        assertThat(report.json().path("visibilitySkipped").toString()).as("the host-shown field was not replayed: " + report)
            .contains("admin_note");
    }

    @Test
    @Order(1954)
    default void hcx04AContextTheClientWritesIsNeverRead() {
        ObjectNode values = nameOnly();
        values.put("admin_note", "forged");
        values.putObject("host").put("role", "admin");
        ObjectNode forged = document(values);
        forged.putObject("hostContext").put("role", "admin");
        ((ObjectNode) forged.get("submission")).putObject("hostContext").put("role", "admin");

        JsonNode accepted = verdict(check(forged, "journey", "user"));
        assertThat(accepted.path("accepted").asBoolean(false)).as(accepted.toString()).isTrue();

        Reply report = post("/submissions/test", TckFixtures.wrapped(forged), "user");
        assertThat(report.status()).as(report.toString()).isEqualTo(200);
        JsonNode body = report.json();
        assertThat(body.path("outcome").asString()).as(report.toString()).isEqualTo("accepted");
        assertThat(body.path("values").isObject()).as(report.toString()).isTrue();
        assertThat(body.path("values").has("admin_note")).as("the forged answer is not stored: " + report).isFalse();

        Reply delivery = post("/submissions", TckFixtures.delivered(forged), "user");
        assertThat(delivery.status()).as(delivery.toString()).isEqualTo(200);
    }
}
