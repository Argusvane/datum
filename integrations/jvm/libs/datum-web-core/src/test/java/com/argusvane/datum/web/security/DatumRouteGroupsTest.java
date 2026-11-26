package com.argusvane.datum.web.security;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.web.openapi.DatumEndpointCatalog;
import com.argusvane.datum.web.openapi.DatumEndpointCatalog.Base;
import com.argusvane.datum.web.openapi.DatumEndpointCatalog.Endpoint;
import com.argusvane.datum.web.security.DatumRouteGroups.Copy;
import com.argusvane.datum.web.security.DatumRouteGroups.Group;
import com.argusvane.datum.web.security.DatumRouteGroups.Route;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * The route groups an application secures: every catalog route is in a group, the definition route in
 * exactly two whose copies never overlap, and the patterns follow the configured bases.
 */
class DatumRouteGroupsTest {

    @Test
    void everyCatalogRouteIsGroupedAndNothingElseIs() {
        List<String> catalog = DatumEndpointCatalog.endpoints().stream().map(Endpoint::operationId).toList();
        assertThat(DatumRouteGroups.operationIds()).as("a route the catalog gained or lost").containsExactlyInAnyOrderElementsOf(catalog);
        List<String> grouped = new ArrayList<>();
        DatumRouteGroups.all().values().forEach(routes -> routes.forEach(route -> grouped.add(route.endpoint().operationId())));
        assertThat(grouped).containsAll(catalog);
        assertThat(DatumRouteGroups.all().keySet()).containsExactly(Group.values());
        assertThat(DatumRouteGroups.all().values()).allSatisfy(routes -> assertThat(routes).isNotEmpty());
    }

    @Test
    void onlyTheDefinitionRouteIsSplitAndItsCopiesNeverOverlap() {
        List<Route> definition = DatumRouteGroups.all().values().stream().flatMap(List::stream)
            .filter(route -> route.endpoint().operationId().equals("getFormDefinition")).toList();
        assertThat(definition).extracting(Route::group).containsExactly(Group.FORMS_READ, Group.BUILDER_READS);
        assertThat(DatumRouteGroups.all().values().stream().flatMap(List::stream).filter(route -> route.copy() != Copy.ANY))
            .hasSize(2);
        List<List<String>> queries = Arrays.asList(null, List.of(), List.of("true"), List.of("true", "true"), List.of("false"),
            List.of("true", "false"), List.of("TRUE"), List.of(""), List.of("0"));
        for (List<String> values : queries) {
            assertThat(Copy.PUBLIC.admits(values) ^ Copy.FULL.admits(values)).as("exactly one copy for " + values).isTrue();
            assertThat(Copy.ANY.admits(values)).isTrue();
        }
        assertThat(Copy.PUBLIC.admits(null)).isTrue();
        assertThat(Copy.PUBLIC.admits(List.of("true"))).isTrue();
        assertThat(Copy.FULL.admits(List.of("false"))).as("the author's copy is the builder's").isTrue();
        assertThat(Copy.FULL.admits(List.of("true", "false"))).as("a mixed query is the stricter group's").isTrue();
        assertThat(Copy.FULL.admits(List.of("TRUE"))).as("only the exact word is the public copy").isTrue();
    }

    @Test
    void theGroupsHoldTheirRoutes() {
        assertThat(ids(Group.BUILDER_WRITES)).containsExactly("createForm", "saveForm", "saveFormTranslations");
        assertThat(ids(Group.SUBMISSIONS)).containsExactly("submitSubmission");
        assertThat(ids(Group.VALIDATE)).containsExactly("validateSubmission");
        assertThat(ids(Group.DRY_RUN)).containsExactly("testSubmission");
        assertThat(ids(Group.INSPECT)).containsExactly("inspectDefinition");
        assertThat(ids(Group.PDF)).containsExactly("renderPdf", "fillPdf", "signPdf");
        assertThat(ids(Group.PDF_VERIFY)).containsExactly("verifyPdf", "serverCertificate");
        assertThat(ids(Group.TSA)).containsExactly("issueTimestamp", "getTimestampCertificate", "getTimestampCertificates");
        assertThat(ids(Group.PASSKEYS)).hasSize(6);
        assertThat(Arrays.stream(Group.values()).map(Group::method)).contains("formsRead", "builderReads", "builderWrites", "dataSources",
            "submissions", "validate", "dryRun", "inspect", "pdf", "pdfVerify", "passkeys", "tsa");
    }

    @Test
    void patternsFollowTheConfiguredBasesAndAGetAlsoAnswersHead() {
        Route definition = DatumRouteGroups.routes(Group.FORMS_READ).get(0);
        assertThat(definition.pattern(Map.of())).isEqualTo("/api/forms/{key}/definition");
        assertThat(definition.pattern(Map.of(Base.API, "/forms-api"))).isEqualTo("/forms-api/forms/{key}/definition");
        assertThat(definition.methods()).containsExactly("GET", "HEAD");
        Route issue = DatumRouteGroups.routes(Group.TSA).get(0);
        assertThat(issue.pattern(Map.of())).isEqualTo("/tsa");
        assertThat(issue.pattern(Map.of(Base.TSA, "stamps/"))).isEqualTo("/stamps");
        assertThat(issue.methods()).containsExactly("POST");
        assertThat(DatumRouteGroups.routes(Group.PASSKEYS).get(0).pattern(Map.of(Base.WEBAUTHN, "/keys"))).isEqualTo("/keys/challenge");
        assertThat(DatumRouteGroups.basePath(Base.TSA, "/")).isEqualTo("/tsa");
        assertThat(DatumRouteGroups.basePath(Base.API, "  ")).isEqualTo("/api");
    }

    private static List<String> ids(Group group) {
        return DatumRouteGroups.routes(group).stream().map(route -> route.endpoint().operationId()).toList();
    }
}
