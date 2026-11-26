package com.argusvane.datum.forms.web;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.forms.DefinitionService;
import com.argusvane.datum.forms.FakeGuestRuntime;
import com.argusvane.datum.forms.Fixtures;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;
import tools.jackson.databind.JsonNode;

/**
 * What the forms read endpoints answer, the same on both stacks. A subclass supplies the application (the MVC
 * controllers on MockMvc, the router function on a random-port Netty server) and the properties; this class
 * holds the expectations so the stacks cannot drift apart. Default configuration: every endpoint on and a 300 ms data-source timeout.
 */
public abstract class FormsWebContract {

    /** A GET with request headers given as name, value pairs. */
    protected abstract Reply get(String path, String... headers);

    /** Any method, same shape as {@link #get}. */
    protected abstract Reply send(String method, String path, String... headers);

    /** The fake sandbox runtime behind the application, to count kernel runs. */
    protected abstract FakeGuestRuntime runtime();

    /** The API base the application was started with. */
    protected String api() {
        return "/api";
    }

    protected static final String FULL_SHA = DefinitionService.hash(Fixtures.endpointFixture());

    /** The hash of the public copy of the secret-rule fixture, as served. */
    protected String publicSha() {
        return DefinitionService.hash(get(api() + "/forms/endpoint/definition").json());
    }

    protected static String quoted(String sha) {
        return "\"" + sha + "\"";
    }

    // ------------------------------------------------------------------ definition

    @Test
    void thePublicCopyHasNoServerSecretRuleAndPublicFalseKeepsIt() {
        assertThat(Fixtures.endpointFixture().toString()).as("the fixture carries the marker").contains("server-secret");

        Reply publicCopy = get(api() + "/forms/endpoint/definition");
        assertThat(publicCopy.status()).isEqualTo(200);
        assertThat(publicCopy.text()).doesNotContain("server-secret");
        assertThat(publicCopy.headers().getContentType().toString()).startsWith("application/json");
        assertThat(publicCopy.headers().getFirst("Cache-Control")).isEqualTo("no-store");
        // The tag names the bytes served: the public copy's own hash, not the full definition's.
        String publicSha = DefinitionService.hash(publicCopy.json());
        assertThat(publicSha).isNotEqualTo(FULL_SHA);
        assertThat(publicCopy.headers().getFirst("ETag")).isEqualTo(quoted(publicSha));
        assertThat(get(api() + "/forms/endpoint/definition?public=true").text()).doesNotContain("server-secret");

        Reply full = get(api() + "/forms/endpoint/definition?public=false");
        assertThat(full.status()).isEqualTo(200);
        assertThat(full.text()).contains("server-secret");
        assertThat(full.json().get("id").asString()).isEqualTo("datum-security-suite");
        assertThat(full.headers().getFirst("ETag")).isEqualTo(quoted(FULL_SHA));
    }

    @Test
    void theCatalogKeyIdAtVersionNamesTheCurrentVersionOnly() {
        // The submissions contract's page key (the security suite's SEC-02 asks for it): "id@version", "@" escaped or not.
        Reply byCatalogKey = get(api() + "/forms/endpoint@1/definition");
        assertThat(byCatalogKey.status()).as(byCatalogKey.text()).isEqualTo(200);
        assertThat(byCatalogKey.text()).doesNotContain("server-secret");
        assertThat(byCatalogKey.json()).isEqualTo(get(api() + "/forms/endpoint/definition").json());
        assertThat(get(api() + "/forms/endpoint%401/definition").status()).isEqualTo(200);
        assertThat(get(api() + "/forms/endpoint@1/definition?public=false").text()).contains("server-secret");
        // Another version, an empty one, or a form that is not there is 404,.
        assertThat(get(api() + "/forms/endpoint@2/definition").status()).isEqualTo(404);
        assertThat(get(api() + "/forms/endpoint@/definition").status()).isEqualTo(404);
        assertThat(get(api() + "/forms/nothing@1/definition").status()).isEqualTo(404);
        assertThat(get(api() + "/forms/@1/definition").status()).isEqualTo(404);
    }

    @Test
    void aFormWithoutSecretRulesIsServedWholeWithoutAKernelRun() {
        long runsBefore = runtime().count("public");
        Reply plain = get(api() + "/forms/plain/definition");
        assertThat(plain.status()).isEqualTo(200);
        assertThat(get(api() + "/forms/plain/definition", "If-None-Match", plain.headers().getFirst("ETag")).status()).isEqualTo(304);
        assertThat(runtime().count("public")).as("no kernel run for a form without secret rules").isEqualTo(runsBefore);
        assertThat(plain.json().get("title").asString()).isEqualTo("A plain form");
    }

    @Test
    void ifNoneMatchAnswers304WithNoBodyAndAStaleTagAnswers200() {
        String sha = publicSha();
        for (String tag : List.of(quoted(sha), "W/" + quoted(sha), sha, "\"other\", " + quoted(sha), "*")) {
            Reply notModified = get(api() + "/forms/endpoint/definition", "If-None-Match", tag);
            assertThat(notModified.status()).as(tag).isEqualTo(304);
            assertThat(notModified.body()).as(tag).isEmpty();
            assertThat(notModified.headers().getFirst("ETag")).isEqualTo(quoted(sha));
            assertThat(notModified.headers().getFirst("Cache-Control")).isEqualTo("no-store");
        }
        // One representation's tag is no proof of the other's: the full definition is not the public copy.
        assertThat(get(api() + "/forms/endpoint/definition", "If-None-Match", quoted(FULL_SHA)).status()).isEqualTo(200);
        assertThat(get(api() + "/forms/endpoint/definition?public=false", "If-None-Match", quoted(sha)).status()).isEqualTo(200);
        assertThat(get(api() + "/forms/endpoint/definition", "If-None-Match", quoted("0".repeat(64))).status()).isEqualTo(200);
        assertThat(get(api() + "/forms/endpoint/definition?public=false", "If-None-Match", quoted(FULL_SHA)).status()).isEqualTo(304);
    }

    @Test
    void aVersionIsServedByHashAndAnUnknownOneIs404() {
        // The current definition's hash always resolves, even before anything snapshotted it.
        Reply byHash = get(api() + "/forms/endpoint/definition?sha256=" + FULL_SHA);
        assertThat(byHash.status()).isEqualTo(200);
        assertThat(byHash.text()).doesNotContain("server-secret");
        assertThat(byHash.headers().getFirst("ETag")).isEqualTo(quoted(publicSha()));
        assertThat(get(api() + "/forms/endpoint/definition?public=false&sha256=" + FULL_SHA).text()).contains("server-secret");
        assertThat(get(api() + "/forms/endpoint/definition?sha256=" + FULL_SHA, "If-None-Match", quoted(publicSha())).status()).isEqualTo(304);

        Reply unknown = get(api() + "/forms/endpoint/definition?sha256=" + "a".repeat(64));
        assertThat(unknown.status()).isEqualTo(404);
        assertThat(unknown.code()).isEqualTo("form.notFound");
        assertThat(get(api() + "/forms/endpoint/definition?sha256=nothex").status()).isEqualTo(404);
    }

    /**
     * The defaults of {@code datum.forms.cache.*}: the current definition and a full copy are {@code no-store}; the public
     * copy of a version asked by hash follow it (no-store): a cacheable header is an explicit opt-in.
     */
    @Test
    void everyDefinitionAnswerIsNoStoreByDefault() {
        Reply byHash = get(api() + "/forms/endpoint/definition?sha256=" + FULL_SHA);
        assertThat(byHash.headers().getFirst("Cache-Control")).isEqualTo("no-store");
        Reply notModified = get(api() + "/forms/endpoint/definition?sha256=" + FULL_SHA, "If-None-Match", byHash.headers().getFirst("ETag"));
        assertThat(notModified.status()).isEqualTo(304);
        assertThat(notModified.headers().getFirst("Cache-Control")).isEqualTo("no-store");
        assertThat(get(api() + "/forms/endpoint/definition").headers().getFirst("Cache-Control")).isEqualTo("no-store");
        assertThat(get(api() + "/forms/endpoint/definition?public=false").headers().getFirst("Cache-Control")).isEqualTo("no-store");
        Reply fullByHash = get(api() + "/forms/endpoint/definition?public=false&sha256=" + FULL_SHA);
        assertThat(fullByHash.headers().getFirst("Cache-Control")).as("a full copy is never shared").isEqualTo("no-store");
    }

    @Test
    void anUnknownFormIs404AndABadPublicParameterIs400() {
        Reply missing = get(api() + "/forms/nope/definition");
        assertThat(missing.status()).isEqualTo(404);
        assertThat(missing.code()).isEqualTo("form.notFound");
        assertThat(missing.headers().getContentType().toString()).startsWith("application/json");
        assertThat(get(api() + "/forms/bad%20key/definition").status()).isEqualTo(404);

        Reply bad = get(api() + "/forms/endpoint/definition?public=maybe");
        assertThat(bad.status()).isEqualTo(400);
        assertThat(bad.code()).isEqualTo("bad_request");
    }

    /** The application's security refuses before the route runs (the chain, written with DatumRequestMatchers). */
    @Test
    void accessDeniedAnswers403BeforeAnythingAboutTheFormIsSaid() {
        Reply denied = get(api() + "/forms/endpoint/definition", "X-Deny", "read");
        assertThat(denied.status()).isEqualTo(403);
        assertThat(denied.code()).isEqualTo("access.denied");
        // A form that does not exist is also 403, not 404, for someone who may not read.
        assertThat(get(api() + "/forms/nope/definition", "X-Deny", "read").status()).isEqualTo(403);
        // public=false is the builder's read (builderReads()), never the public read (formsRead()).
        assertThat(get(api() + "/forms/endpoint/definition?public=false", "X-Deny", "build").status()).isEqualTo(403);
        assertThat(get(api() + "/forms/endpoint/definition?public=false", "X-Deny", "read").status()).isEqualTo(200);
        assertThat(get(api() + "/forms/endpoint/definition", "X-Deny", "build").status()).isEqualTo(200);
    }

    // ------------------------------------------------------------------ both stacks alike

    @Test
    void repeatedQueryParametersAreReadTheSameOnBothStacks() {
        // MVC joins repeated values with a comma; WebFlux does the same, so each is one bad value.
        Reply bad = get(api() + "/forms/endpoint/definition?public=false&public=true");
        assertThat(bad.status()).isEqualTo(400);
        assertThat(bad.code()).isEqualTo("bad_request");
        assertThat(get(api() + "/forms/endpoint/definition?sha256=" + FULL_SHA + "&sha256=" + FULL_SHA).status()).isEqualTo(404);
    }

    @Test
    void aWrongMethodIs405AndAnAcceptHeaderDoesNotChangeTheAnswer() {
        assertThat(send("POST", api() + "/forms/endpoint/definition").status()).isEqualTo(405);
        assertThat(send("DELETE", api() + "/forms/endpoint/translations").status()).isEqualTo(405);
        assertThat(send("PUT", api() + "/data-sources/colours").status()).isEqualTo(405);
        assertThat(get(api() + "/forms/endpoint/definition", "Accept", "text/html").status()).isEqualTo(200);
    }

    @Test
    void headIsServedLikeGet() {
        Reply head = send("HEAD", api() + "/forms/endpoint/definition");
        assertThat(head.status()).isEqualTo(200);
        assertThat(head.headers().getFirst("ETag")).isEqualTo(quoted(publicSha()));
    }

    // ------------------------------------------------------------------ translations

    @Test
    void translationsAnswerTheCatalogWithAnEtag() {
        Reply catalog = get(api() + "/forms/endpoint/translations");
        assertThat(catalog.status()).isEqualTo(200);
        assertThat(catalog.json().get("catalog").isObject()).isTrue();
        assertThat(catalog.json().get("catalog").size()).isZero();
        String etag = catalog.headers().getFirst("ETag");
        assertThat(etag).startsWith("\"").hasSize(66);

        Reply notModified = get(api() + "/forms/endpoint/translations", "If-None-Match", etag);
        assertThat(notModified.status()).isEqualTo(304);
        assertThat(notModified.body()).isEmpty();
    }

    @Test
    void translationsOfAnUnknownFormAre404AndADeniedReadIs403() {
        assertThat(get(api() + "/forms/nope/translations").code()).isEqualTo("form.notFound");
        Reply denied = get(api() + "/forms/endpoint/translations", "X-Deny", "read");
        assertThat(denied.status()).isEqualTo(403);
        assertThat(denied.code()).isEqualTo("access.denied");
    }

    // ------------------------------------------------------------------ data sources

    @Test
    void aDataSourceAnswersItsItemsInTheLocale() {
        Reply colours = get(api() + "/data-sources/colours?locale=fr-CA");
        assertThat(colours.status()).isEqualTo(200);
        JsonNode items = colours.json().get("items");
        assertThat(items).hasSize(2);
        assertThat(items.get(0).get("value").asString()).isEqualTo("red");
        assertThat(items.get(0).get("label").asString()).isEqualTo("Red [fr-CA]");
        // Anything that is not a locale code reads as the application's default.
        assertThat(get(api() + "/data-sources/colours?locale=%3Cb%3E").json().get("items").get(0).get("label").asString()).isEqualTo("Red []");
        assertThat(get(api() + "/data-sources/colours").json().get("items").get(0).get("label").asString()).isEqualTo("Red []");
    }

    @Test
    void anUnknownSourceIs404AWorkerTimeoutAndAFailureAre503AndNothingLeaks() {
        Reply unknown = get(api() + "/data-sources/nope");
        assertThat(unknown.status()).isEqualTo(404);
        assertThat(unknown.code()).isEqualTo("data_source.notFound");

        Reply slow = get(api() + "/data-sources/slow");
        assertThat(slow.status()).isEqualTo(503);
        assertThat(slow.code()).isEqualTo("data_source.unavailable");

        Reply broken = get(api() + "/data-sources/broken");
        assertThat(broken.status()).isEqualTo(503);
        assertThat(broken.code()).isEqualTo("data_source.unavailable");
        assertThat(broken.text()).doesNotContain("SECRET");
    }

    /** The per-form recipe: the application's rule reads the form being filled from the request. */
    @Test
    void theFormParameterReachesTheApplicationsSecurity() {
        assertThat(get(api() + "/data-sources/colours?form=locked").status()).isEqualTo(403);
        assertThat(get(api() + "/data-sources/colours?form=locked").code()).isEqualTo("access.denied");
        assertThat(get(api() + "/data-sources/colours?form=endpoint").status()).isEqualTo(200);
        assertThat(get(api() + "/data-sources/colours?form=locked%20x").status()).isEqualTo(200);
    }

    @Test
    void aDeniedDataSourceReadIs403() {
        Reply denied = get(api() + "/data-sources/colours", "X-Deny", "source");
        assertThat(denied.status()).isEqualTo(403);
        assertThat(denied.code()).isEqualTo("access.denied");
    }

    // ------------------------------------------------------------------ OpenAPI

    /** The paths of the {@code datum-forms} springdoc group. */
    protected Set<String> documentedPaths() {
        Reply doc = get("/v3/api-docs/datum-forms");
        assertThat(doc.status()).isEqualTo(200);
        Set<String> paths = new TreeSet<>();
        JsonNode node = doc.json().path("paths");
        node.propertyNames().forEach(paths::add);
        return paths;
    }

    /** The paths this configuration documents. */
    protected Set<String> expectedPaths() {
        Set<String> paths = new TreeSet<>(List.of(api() + "/forms/{key}/definition", api() + "/forms/{key}/translations", api() + "/data-sources/{id}"));
        return paths;
    }

    @Test
    void theOpenApiDocumentListsExactlyTheEnabledRoutes() {
        assertThat(documentedPaths()).isEqualTo(expectedPaths());
    }

    @Test
    void theDocumentedOperationsCarryTheirResponsesAndDatumsCommonErrors() {
        JsonNode doc = get("/v3/api-docs/datum-forms").json();
        JsonNode definition = doc.at("/paths/" + api().replace("/", "~1") + "~1forms~1{key}~1definition/get");
        assertThat(definition.isMissingNode()).isFalse();
        assertThat(definition.get("operationId").asString()).isEqualTo("getFormDefinition");
        assertThat(definition.get("tags").get(0).asString()).isEqualTo("datum-forms");
        assertThat(definition.get("responses").propertyNames()).contains("200", "304", "403", "404", "500", "503");
        assertThat(definition.get("parameters")).extracting(p -> p.get("name").asString()).contains("key", "public", "sha256");
        assertThat(doc.at("/components/schemas").propertyNames()).contains("ErrorsBody");
    }

    /** The document holds to the library's endpoint catalog (integrations/jvm/README.md "Libraries and bindings"), on this stack. */
    @Test
    void theDocumentHoldsToTheEndpointCatalog() {
        JsonNode doc = get("/v3/api-docs/datum-forms").json();
        java.util.Map<com.argusvane.datum.web.openapi.DatumEndpointCatalog.Base, String> bases = java.util.Map.of(com.argusvane.datum.web.openapi.DatumEndpointCatalog.Base.API, api());
        assertThat(com.argusvane.datum.web.openapi.DatumEndpointCatalog.differences(doc, bases)).isEmpty();
        assertThat(com.argusvane.datum.web.openapi.DatumEndpointCatalog.missing(doc, "forms", bases,
            endpoint -> endpoint.capability().equals("forms") && expectedPaths().contains(endpoint.path(api())))).isEmpty();
    }
}
