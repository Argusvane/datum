package com.argusvane.datum.web.openapi;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.web.openapi.DatumEndpointCatalog.Base;
import com.argusvane.datum.web.openapi.DatumEndpointCatalog.Endpoint;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** The endpoint catalog itself and the check that holds a binding's document to it (integrations/jvm/README.md "Libraries and bindings"). */
class DatumEndpointCatalogTest {

    private static final JsonMapper JSON = JsonMapper.builder().build();

    @Test
    void theCatalogIsConsistent() {
        assertThat(DatumEndpointCatalog.selfCheck()).isEmpty();
        assertThat(DatumEndpointCatalog.endpoints()).hasSize(24);
        assertThat(DatumEndpointCatalog.group("datum-forms")).extracting(Endpoint::operationId)
            .containsExactly("getFormDefinition", "getFormTranslations", "getDataSourceItems", "createForm", "saveForm",
                "saveFormTranslations");
        assertThat(DatumEndpointCatalog.group("ui")).hasSize(3);
        Endpoint submit = DatumEndpointCatalog.endpoint("submitSubmission").orElseThrow();
        assertThat(submit.path("/shop/api")).isEqualTo("/shop/api/submissions");
        assertThat(DatumEndpointCatalog.documentedStatuses(submit)).containsExactly(200, 400, 403, 404, 409, 413, 415, 422, 429, 500, 503);
        assertThat(DatumEndpointCatalog.defaultResponses(false, "GET")).containsOnlyKeys(500, 503);
        assertThat(DatumEndpointCatalog.sharedResponses()).filteredOn(response -> response.status() == 429).singleElement()
            .satisfies(response -> assertThat(response.codes()).containsExactly("flood"));
    }

    /** A run that gave no answer is the server's failure: 503 with the run's own code, on every route that runs the kernel. */
    @Test
    void aFailedRunIsListedUnderThe503OfEveryRouteThatRunsTheKernelAndNeverUnderA422() {
        for (String id : new String[] {"submitSubmission", "validateSubmission", "testSubmission", "inspectDefinition", "renderPdf",
            "fillPdf", "signPdf", "verifyPdf"}) {
            Endpoint endpoint = DatumEndpointCatalog.endpoint(id).orElseThrow();
            assertThat(endpoint.status(503).orElseThrow().codes()).as(id).contains("wasm.execution_error", "outcome_too_large");
            endpoint.status(422).ifPresent(refusal -> assertThat(refusal.codes()).as(id + " 422").doesNotContain("wasm.execution_error", "outcome_too_large"));
        }
        // A registered form nested too deep is the server's (503); the verify route has no form, and a posted definition is the caller's.
        for (String id : new String[] {"submitSubmission", "validateSubmission", "testSubmission", "inspectDefinition", "renderPdf", "fillPdf", "signPdf"}) {
            assertThat(DatumEndpointCatalog.endpoint(id).orElseThrow().status(503).orElseThrow().codes()).as(id).contains("definition.tooDeep");
        }
        assertThat(DatumEndpointCatalog.endpoint("verifyPdf").orElseThrow().status(503).orElseThrow().codes()).doesNotContain("definition.tooDeep");
    }

    /** Only {@code server.busy} sends {@code Retry-After} on a 503 of the JSON routes: the catalog says so per code. */
    @Test
    void retryAfterOnA503IsLimitedToServerBusy() {
        for (String id : new String[] {"getDataSourceItems", "submitSubmission", "validateSubmission", "testSubmission", "inspectDefinition",
            "renderPdf", "fillPdf", "signPdf", "verifyPdf"}) {
            DatumEndpointCatalog.Status status = DatumEndpointCatalog.endpoint(id).orElseThrow().status(503).orElseThrow();
            assertThat(status.headers()).as(id).containsExactly("Retry-After");
            assertThat(status.headerCodes()).as(id).containsOnlyKeys("Retry-After");
            assertThat(status.headerCodes().get("Retry-After")).as(id).containsExactly("server.busy");
            for (String code : status.codes()) {
                assertThat(status.sends("Retry-After", code)).as(id + " " + code).isEqualTo(code.equals("server.busy"));
            }
        }
        // A status that limits nothing sends its header with every code (the timestamp server's 503).
        DatumEndpointCatalog.Status timestamp = DatumEndpointCatalog.endpoint("issueTimestamp").orElseThrow().status(503).orElseThrow();
        assertThat(timestamp.headerCodes()).isEmpty();
        assertThat(timestamp.sends("Retry-After", "anything")).isTrue();
        assertThat(timestamp.sends("ETag", "anything")).isFalse();
        assertThat(DatumEndpointCatalog.sharedResponses()).filteredOn(response -> response.status() == 503).singleElement().satisfies(response -> {
            assertThat(response.retryAfter()).isTrue();
            assertThat(response.retryAfterCodes()).containsExactly("server.busy");
        });
    }

    /**
     * integrations/shared/endpoint-catalog.json is the catalog for the hosts that are not Java (the Node conformance kit
     * reads it). The Java catalog is the source: when the committed file differs, regenerate it with
     * {@code ./mvnw -pl libs/datum-web-core test -Dtest=DatumEndpointCatalogTest -Ddatum.catalog.write=true} and commit it.
     */
    @Test
    void theSharedCatalogIsCurrent() throws IOException {
        // Maven runs a module's tests from the module directory: libs/datum-web-core -> integrations/shared.
        Path file = Path.of("../../../shared/endpoint-catalog.json").toAbsolutePath().normalize();
        String expected = DatumEndpointCatalogJson.json();
        if (Boolean.getBoolean("datum.catalog.write")) {
            Files.writeString(file, expected, StandardCharsets.UTF_8);
            return;
        }
        assertThat(file).as("%s is missing; write it with -Ddatum.catalog.write=true", file).exists();
        assertThat(Files.readString(file, StandardCharsets.UTF_8))
            .as("integrations/shared/endpoint-catalog.json differs from DatumEndpointCatalog; regenerate it with -Ddatum.catalog.write=true")
            .isEqualTo(expected);
    }

    private static String document(String responses) {
        return "{\"paths\":{\"/api/submissions\":{\"post\":{\"operationId\":\"submitSubmission\",\"tags\":[\"datum-submissions\"],"
            + "\"responses\":{" + responses + "}}}}}";
    }

    private static final String SUBMIT_RESPONSES = "\"200\":{\"description\":\"ok\"},\"403\":{\"description\":\"(access.denied)\"},"
        + "\"404\":{\"description\":\"(form.notFound)\"},\"409\":{\"description\":\"(form.outdated) (submission.keyConflict)\"},\"400\":{\"$ref\":\"x\"},"
        + "\"413\":{\"$ref\":\"x\"},\"415\":{\"$ref\":\"x\"},\"422\":{\"$ref\":\"x\"},\"429\":{\"$ref\":\"x\"},\"500\":{\"$ref\":\"x\"},"
        + "\"503\":{\"$ref\":\"x\"}";

    @Test
    void aDocumentThatHoldsToTheCatalogHasNoDifferences() {
        JsonNode doc = JSON.readTree(document(SUBMIT_RESPONSES));
        assertThat(DatumEndpointCatalog.differences(doc, Map.of())).isEmpty();
        assertThat(DatumEndpointCatalog.missing(doc, "submissions", Map.of(), endpoint -> endpoint.operationId().equals("submitSubmission")))
            .isEmpty();
        assertThat(DatumEndpointCatalog.missing(doc, "submissions", Map.of(), endpoint -> true)).hasSize(3);
    }

    @Test
    void everyKindOfDifferenceIsNamed() {
        JsonNode extraStatus = JSON.readTree(document(SUBMIT_RESPONSES + ",\"418\":{\"description\":\"teapot\"}"));
        assertThat(DatumEndpointCatalog.differences(extraStatus, Map.of())).singleElement().asString().contains("documents");
        JsonNode lostCode = JSON.readTree(document(SUBMIT_RESPONSES.replace("(form.outdated)", "(stale)")));
        assertThat(DatumEndpointCatalog.differences(lostCode, Map.of())).singleElement().asString().contains("form.outdated");
        JsonNode moved = JSON.readTree(document(SUBMIT_RESPONSES));
        assertThat(DatumEndpointCatalog.differences(moved, Map.of(Base.API, "/v2"))).singleElement().asString().contains("/v2/submissions");
        JsonNode unknown = JSON.readTree("{\"paths\":{\"/api/x\":{\"get\":{\"operationId\":\"mine\",\"responses\":{}}}}}");
        assertThat(DatumEndpointCatalog.differences(unknown, Map.of())).singleElement().asString().contains("not in the catalog");
        JsonNode noHeader = JSON.readTree("{\"paths\":{\"/api/forms/{key}/translations\":{\"get\":{\"operationId\":\"getFormTranslations\","
            + "\"tags\":[\"datum-forms\"],\"responses\":{\"200\":{\"description\":\"ok\"},\"304\":{\"description\":\"same\",\"headers\":{\"ETag\":{}}},"
            + "\"403\":{\"description\":\"(access.denied)\"},\"404\":{\"description\":\"(form.notFound)\"},\"500\":{\"$ref\":\"x\"},"
            + "\"503\":{\"$ref\":\"x\"}}}}}}");
        assertThat(DatumEndpointCatalog.differences(noHeader, Map.of())).singleElement().asString().contains("200: no ETag header");
    }
}
