package com.argusvane.datum.tck;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;

/**
 * The dry-run route ({@code POST /submissions/test}, off unless {@code datum.web.api.endpoints.test=true}): the report
 * holds the values the kernel kept for the golden valid document, exactly as the golden file has them, and is one flat
 * report of exactly fourteen members, accepted or refused, the same on every host.
 */
public interface SubmissionsDryRunContract extends HostContract {

    @Test
    @Order(1150)
    default void aDryRunReportsTheValuesTheKernelKeptForTheGoldenDocument() {
        Reply reply = http().postJson(target().api("/submissions/test"), TckFixtures.wrapped(TckFixtures.envelope("CTL-01")));
        assertThat(reply.status()).as(reply.toString()).isEqualTo(200);
        JsonNode report = reply.json();
        assertThat(report.path("outcome").asString()).isEqualTo("accepted");
        assertThat(report.path("values")).isEqualTo(TckFixtures.golden().path("controls").path("CTL-01").path("values"));
    }

    /** The report's members, in the order the wire page lists them. No other member is allowed. */
    List<String> DRY_RUN_MEMBERS = List.of("outcome", "stage", "errors", "sent", "values", "clientDerived", "clockDependent",
        "serverRules", "visibilitySkipped", "document", "digest", "logs", "sandbox", "signature");

    @Test
    @Order(1151)
    default void anAcceptedDryRunIsOneFlatReportOfFourteenMembers() {
        Reply reply = http().postJson(target().api("/submissions/test"), TckFixtures.wrapped(TckFixtures.envelope("CTL-01")));
        assertThat(reply.status()).as(reply.toString()).isEqualTo(200);
        JsonNode report = reply.json();
        assertTheReportShape(report);
        assertThat(report.path("outcome").asString()).isEqualTo("accepted");
        assertThat(report.get("stage").isNull()).as("stage is null when accepted: " + report).isTrue();
        assertThat(report.get("values").isObject()).as("values: " + report).isTrue();
        assertThat(report.get("document").isString()).as("a run happened, so there is a document: " + report).isTrue();
        assertThat(report.get("digest").isString()).as("a run happened, so there is a digest: " + report).isTrue();
        assertThat(report.get("digest").asString()).matches("^[0-9a-f]{64}$");
        assertThat(report.get("sandbox").isObject()).as("a run happened, so there is a sandbox: " + report).isTrue();
    }

    @Test
    @Order(1152)
    default void aRefusedDryRunKeepsTheSameShapeAndNamesTheStage() {
        Reply reply = http().postJson(target().api("/submissions/test"), TckFixtures.wrapped(TckFixtures.envelope("CTL-02")));
        assertThat(reply.status()).as(reply.toString()).isEqualTo(200);
        JsonNode report = reply.json();
        assertTheReportShape(report);
        assertThat(report.path("outcome").asString()).isEqualTo("rejected");
        assertThat(report.path("stage").asString()).as(report.toString()).isEqualTo("sandbox");
        assertThat(report.get("errors").size()).as("a refusal lists its findings: " + report).isPositive();
        assertThat(report.get("values").isNull() || report.get("values").isObject()).as("values: " + report).isTrue();
        assertThat(report.get("digest").asString()).as("the run happened, so there is a digest: " + report).matches("^[0-9a-f]{64}$");
    }

    /**
     * The one shape of a dry-run report: exactly {@link #DRY_RUN_MEMBERS} (no {@code accepted}, no nested {@code report},
     * no {@code notes}); {@code errors} entries with all six keys (null where unknown, severity never null); the four
     * lists string arrays; {@code logs} an array; {@code sandbox} and {@code signature} null or an object.
     */
    private static void assertTheReportShape(JsonNode report) {
        List<String> members = new ArrayList<>();
        report.propertyNames().forEach(members::add);
        assertThat(members).as(report.toString()).containsExactlyInAnyOrderElementsOf(DRY_RUN_MEMBERS);
        assertThat(report.get("outcome").asString()).isIn("accepted", "rejected");
        JsonNode stage = report.get("stage");
        assertThat(stage.isNull() || stage.isString()).as("stage: " + stage).isTrue();
        if (stage.isString()) {
            assertThat(stage.asString()).isIn("journey", "sandbox", "signature", "server");
        }
        assertThat(report.get("errors").isArray()).as(report.toString()).isTrue();
        for (JsonNode error : report.get("errors")) {
            List<String> keys = new ArrayList<>();
            error.propertyNames().forEach(keys::add);
            assertThat(keys).as(error.toString()).containsExactlyInAnyOrder("field", "code", "message", "severity", "stage", "source");
            assertThat(error.get("code").isString()).as(error.toString()).isTrue();
            assertThat(error.get("severity").isString()).as("severity defaults to error: " + error).isTrue();
        }
        assertThat(report.get("sent").isObject()).as("sent: " + report).isTrue();
        JsonNode values = report.get("values");
        assertThat(values.isNull() || values.isObject()).as("values: " + values).isTrue();
        for (String list : new String[] {"clientDerived", "clockDependent", "serverRules", "visibilitySkipped"}) {
            assertThat(report.get(list).isArray()).as(list + ": " + report).isTrue();
            for (JsonNode id : report.get(list)) {
                assertThat(id.isString()).as(list + ": " + report).isTrue();
            }
        }
        assertThat(report.get("document").isNull() || report.get("document").isString()).as(report.toString()).isTrue();
        JsonNode digest = report.get("digest");
        assertThat(digest.isNull() || digest.isString()).as(report.toString()).isTrue();
        if (digest.isString()) {
            assertThat(digest.asString()).matches("^[0-9a-f]{64}$");
        }
        assertThat(report.get("logs").isArray()).as(report.toString()).isTrue();
        JsonNode sandbox = report.get("sandbox");
        assertThat(sandbox.isNull() || sandbox.isObject()).as(report.toString()).isTrue();
        if (sandbox.isObject()) {
            List<String> keys = new ArrayList<>();
            sandbox.propertyNames().forEach(keys::add);
            assertThat(keys).containsExactlyInAnyOrder("elapsedMs", "rules", "unknownFields", "logLevel");
        }
        JsonNode signature = report.get("signature");
        assertThat(signature.isNull() || signature.isObject()).as(report.toString()).isTrue();
        if (signature.isObject()) {
            assertThat(signature.get("status").isString()).as(signature.toString()).isTrue();
            assertThat(signature.get("errors").isArray()).as(signature.toString()).isTrue();
        }
    }
}
