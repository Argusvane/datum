package com.argusvane.datum.ui.builder;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.core.contracts.DatumJson;
import com.argusvane.datum.forms.DefinitionService;
import com.argusvane.datum.forms.translation.TranslationCatalogStore;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * The builder's write endpoints over HTTP, the same on both stacks: the subclasses supply the transport (MockMvc,
 * or a random-port Netty server) with {@code datum.builder.enabled=true} and a 256 KB definition cap; this class
 * holds the expectations so the stacks cannot drift apart. The refusal order is walked one step at a time: each
 * request carries every later fault too, so it proves the step that answers comes first.
 */
public abstract class BuilderWebContract {

    static final String KEY = BuilderFixtures.KEY;
    static final String FORM = "/api/forms/" + KEY;
    static final String JSON = "application/json";
    static final String STALE = "\"" + "0".repeat(64) + "\"";
    static final int CAP = 256 * 1024;

    /** Each test saves its own versions, so the definition service's verdict cache never answers for another test. */
    private static final AtomicInteger VERSIONS = new AtomicInteger();

    @Autowired
    protected KernelStub kernel;

    @Autowired
    protected MemoryRepository repository;

    @Autowired
    protected TranslationCatalogStore catalogs;

    /** Any method; headers as name, value pairs; a null body sends none. */
    protected abstract Http.Reply send(String method, String path, byte[] body, String... headers);

    @BeforeEach
    void resetState() {
        kernel.reset();
        repository.clear();
        repository.seed(BuilderFixtures.base());
        catalogs.write(KEY, com.argusvane.datum.forms.translation.TranslationCatalog.empty(), null);
    }

    static ObjectNode fresh() {
        ObjectNode definition = BuilderFixtures.base();
        definition.put("version", "v" + VERSIONS.incrementAndGet());
        return definition;
    }

    static byte[] bytes(JsonNode node) {
        return DatumJson.mapper().writeValueAsBytes(node);
    }

    static byte[] bytes(String text) {
        return text.getBytes(StandardCharsets.UTF_8);
    }

    static String[] with(String[] first, String... more) {
        List<String> all = new ArrayList<>(List.of(first));
        all.addAll(List.of(more));
        return all.toArray(String[]::new);
    }

    Http.Reply put(String path, byte[] body, String... headers) {
        return send("PUT", path, body, with(new String[] {"Content-Type", JSON}, headers));
    }

    /** A body over the cap that is not even JSON. */
    static byte[] tooLarge() {
        return bytes("x".repeat(CAP + 1));
    }

    @Test
    void aSaveRoundTripsWithTheReadEndpointsTags() {
        Http.Reply loaded = send("GET", FORM + "/definition?public=false", null);
        assertThat(loaded.status()).isEqualTo(200);
        ObjectNode next = fresh();

        Http.Reply saved = put(FORM, bytes(next), "If-Match", loaded.header("ETag"));

        assertThat(saved.status()).isEqualTo(200);
        String sha = DefinitionService.hash(next);
        assertThat(saved.header("ETag")).isEqualTo("\"" + sha + "\"");
        assertThat(saved.header("Content-Type")).startsWith("application/json");
        assertThat(saved.json().get("sha256").asString()).isEqualTo(sha);
        assertThat(send("GET", FORM + "/definition?public=false", null).header("ETag")).isEqualTo(saved.header("ETag"));
        assertThat(repository.saves()).isEqualTo(1);
        // The page that loaded the first version is behind now.
        Http.Reply stale = put(FORM, bytes(fresh()), "If-Match", loaded.header("ETag"));
        assertThat(stale.status()).isEqualTo(409);
        assertThat(stale.code()).isEqualTo("form.outdated");
        assertThat(stale.header("ETag")).isEqualTo(saved.header("ETag"));
        assertThat(stale.json().get("currentSha256").asString()).isEqualTo(sha);
    }

    /** The application's security refuses first (the chain, before the route's own 404, 415 and 413). */
    @Test
    void theRefusalsComeInTheirOrderAndStoreNothing() {
        ObjectNode risky = BuilderFixtures.riskyPattern();
        kernel.answer(risky, BuilderFixtures.capturedAnswer("riskyPattern"));

        Http.Reply forbidden = send("PUT", "/api/forms/no-such-form", tooLarge(), "Content-Type", "text/plain", "X-Deny", "build");
        assertThat(forbidden.status()).isEqualTo(403);
        assertThat(forbidden.code()).isEqualTo("access.denied");

        Http.Reply missing = send("PUT", "/api/forms/no-such-form", tooLarge(), "Content-Type", "text/plain");
        assertThat(missing.status()).isEqualTo(404);
        assertThat(missing.code()).isEqualTo("form.notFound");

        Http.Reply media = send("PUT", FORM, tooLarge(), "Content-Type", "text/plain", "If-Match", STALE);
        assertThat(media.status()).isEqualTo(415);

        Http.Reply large = put(FORM, tooLarge(), "If-Match", STALE);
        assertThat(large.status()).isEqualTo(413);
        assertThat(large.code()).isEqualTo("bad_document");

        Http.Reply outdated = put(FORM, bytes("not json"), "If-Match", STALE);
        assertThat(outdated.status()).isEqualTo(409);

        Http.Reply notJson = put(FORM, bytes("not json"));
        assertThat(notJson.status()).isEqualTo(400);
        assertThat(notJson.code()).isEqualTo("bad_document");

        Http.Reply otherId = put(FORM, bytes("{\"id\":\"other\",\"version\":\"1\",\"schemaVersion\":\"1\",\"root\":{\"id\":\"r\",\"type\":\"form\"}}"),
            "X-Datum-Locale-Changes", "{");
        assertThat(otherId.status()).isEqualTo(422);
        assertThat(otherId.json().get("kernel").get(0).get("code").asString()).isEqualTo("definition.id.mismatch");

        Http.Reply header = put(FORM, bytes(risky), "X-Datum-Locale-Changes", "{");
        assertThat(header.status()).isEqualTo(400);
        assertThat(kernel.checks()).as("nothing so far reached the kernel").isEmpty();

        Http.Reply refused = put(FORM, bytes(risky));
        assertThat(refused.status()).isEqualTo(422);
        assertThat(refused.code()).isEqualTo("pattern.risky");
        assertThat(refused.json().get("kernel").get(0).get("where").asString()).isEqualTo("rules:fx:visibleWhen");
        assertThat(refused.json().get("errors").get(0).get("message").asString()).contains("(a|a?)+");

        kernel.mode(KernelStub.Mode.UNAVAILABLE);
        Http.Reply unavailable = put(FORM, bytes(fresh()));
        assertThat(unavailable.status()).isEqualTo(503);
        assertThat(unavailable.json().get("code").asString()).isEqualTo("server.unavailable");

        assertThat(repository.saves()).as("no refusal stored anything").isZero();
        assertThat(repository.hashOf(KEY)).isEqualTo(DefinitionService.hash(BuilderFixtures.base()));
    }

    @Test
    void aSaveThatRemovesLocalesSaysWhichAndDropsThem() {
        ObjectNode before = fresh();
        var listed = before.putObject("localization").putArray("supportedLocales");
        for (String code : new String[] {"en", "fr", "de"}) {
            listed.addObject().put("code", code);
        }
        repository.seed(before);
        catalogs.write(KEY, (ObjectNode) com.argusvane.datum.core.contracts.DatumJson.mapper().readTree(
            "{\"de\":{\"form\":{\"title\":\"Hallo\"}},\"en\":{\"form\":{\"title\":\"Hello\"}},\"fr\":{\"form\":{\"title\":\"Bonjour\"}}}"), null);
        ObjectNode after = before.deepCopy();
        var kept = after.putObject("localization").putArray("supportedLocales");
        kept.addObject().put("code", "en");
        kept.addObject().put("code", "fr-CA");

        Http.Reply saved = put(FORM, bytes(after), "X-Datum-Locale-Changes", "{\"removed\":[],\"renamed\":[{\"from\":\"fr\",\"to\":\"fr-CA\"}]}");

        assertThat(saved.status()).isEqualTo(200);
        assertThat(saved.header(BuilderApi.REMOVED_LOCALES_HEADER)).isEqualTo("de");
        Http.Reply catalog = send("GET", FORM + "/translations", null);
        assertThat(catalog.json().get("catalog").toString()).isEqualTo("{\"en\":{\"form\":{\"title\":\"Hello\"}},\"fr-CA\":{\"form\":{\"title\":\"Bonjour\"}}}");
        assertThat(saved.json().get("catalog")).isEqualTo(catalog.json().get("catalog"));
    }

    @Test
    void translationsAreGuardedByTheCatalogsTag() {
        Http.Reply loaded = send("GET", FORM + "/translations", null);
        assertThat(loaded.status()).isEqualTo(200);

        Http.Reply saved = put(FORM + "/translations", bytes("{\"catalog\":{\"fr\":{\"form\":{\"title\":\"Bonjour\"}}}}"), "If-Match", loaded.header("ETag"));
        assertThat(saved.status()).isEqualTo(200);
        assertThat(saved.json().get("entries").asInt()).isEqualTo(1);
        assertThat(send("GET", FORM + "/translations", null).header("ETag")).isEqualTo(saved.header("ETag"));

        Http.Reply stale = put(FORM + "/translations", bytes("{\"catalog\":{\"fr\":{\"form\":{\"title\":\"Salut\"}}}}"), "If-Match", loaded.header("ETag"));
        assertThat(stale.status()).isEqualTo(409);
        assertThat(stale.header("ETag")).isEqualTo(saved.header("ETag"));

        Http.Reply invalid = put(FORM + "/translations", bytes("{\"catalog\":{\"fr\":{\"keys\":{\"1x\":\"x\"}}}}"));
        assertThat(invalid.status()).isEqualTo(422);
        assertThat(invalid.json().get("code").asString()).isEqualTo("catalog.invalid");

        assertThat(send("PUT", "/api/forms/no-such-form/translations", bytes("{}"), "Content-Type", JSON).status()).isEqualTo(404);
        assertThat(send("PUT", FORM + "/translations", bytes("{}"), "Content-Type", JSON, "X-Deny", "build").status()).isEqualTo(403);
    }

    @Test
    void aFormIsCreatedOnceUnderItsId() {
        ObjectNode intake = fresh();
        intake.put("id", "intake");

        Http.Reply created = send("POST", "/api/forms", bytes(intake), "Content-Type", JSON);
        assertThat(created.status()).isEqualTo(201);
        assertThat(created.header("Location")).isEqualTo("/api/forms/intake/definition?public=false");
        assertThat(created.header("ETag")).isEqualTo("\"" + DefinitionService.hash(intake) + "\"");
        assertThat(send("GET", "/api/forms/intake/definition?public=false", null).status()).isEqualTo(200);

        Http.Reply again = send("POST", "/api/forms", bytes(intake), "Content-Type", JSON);
        assertThat(again.status()).isEqualTo(409);
        assertThat(again.json().get("code").asString()).isEqualTo("form.exists");
        assertThat(send("POST", "/api/forms", bytes(intake), "Content-Type", JSON, "X-Deny", "build").status()).isEqualTo(403);
    }

    @Test
    void aWrongMethodOnTheSaveRouteIs405() {
        Http.Reply reply = send("GET", FORM, null);
        assertThat(reply.status()).isEqualTo(405);
        assertThat(reply.header("Allow")).contains("PUT");
    }

    /**
     * A wrong method names every method served on the path, the forms module's reads included, and an
     * application's own route on a builder path stays the application's, on both stacks.
     */
    @Test
    void wrongMethodsNameEveryMethodAndTheApplicationsOwnRoutesStayItsOwn() {
        Http.Reply translations = send("DELETE", FORM + "/translations", null);
        assertThat(translations.status()).isEqualTo(405);
        assertThat(translations.header("Allow")).contains("GET").contains("PUT");

        Http.Reply forms = send("DELETE", "/api/forms", null);
        assertThat(forms.status()).isEqualTo(405);
        assertThat(forms.header("Allow")).contains("POST");

        assertThat(send("GET", FORM + "/translations", null).status()).as("the forms module still reads").isEqualTo(200);

        Http.Reply own = send("DELETE", FORM, null);
        assertThat(own.status()).isEqualTo(204);
        assertThat(own.header("X-App")).isEqualTo("deleted");
    }

    /**
     * A header sent on several lines is read whole on both stacks. Several If-Match lines are one list
     * (RFC 9110): it matches when any tag in it is the current one, and is refused when none is (MVC used to refuse
     * every list, WebFlux to save on the first line); two locale-change lines are not one JSON value.
     */
    @Test
    void aRepeatedHeaderIsReadWholeOnBothStacks() {
        String current = send("GET", FORM + "/definition?public=false", null).header("ETag");

        Http.Reply twoStale = put(FORM, bytes(fresh()), "If-Match", STALE, "If-Match", "\"another-stale-tag\"");
        assertThat(twoStale.status()).isEqualTo(409);

        Http.Reply twoChanges = put(FORM, bytes(fresh()), "X-Datum-Locale-Changes", "{\"removed\":[]}", "X-Datum-Locale-Changes", "{\"removed\":[]}");
        assertThat(twoChanges.status()).isEqualTo(400);
        assertThat(twoChanges.code()).isEqualTo("bad_document");
        assertThat(repository.saves()).isZero();

        assertThat(put(FORM, bytes(fresh()), "If-Match", current, "If-Match", STALE).status()).as("a list naming the current tag saves").isEqualTo(200);
        String saved = send("GET", FORM + "/definition?public=false", null).header("ETag");
        assertThat(put(FORM, bytes(fresh()), "If-Match", saved).status()).as("one line saves").isEqualTo(200);
    }

    /** A lone surrogate escape is the client's malformed body (400), never the server's 503. */
    @Test
    void aLoneSurrogateIsTheClientsMalformedBody400NotAServerFault() {
        String text = new String(bytes(fresh()), StandardCharsets.UTF_8).replaceFirst("\"version\":\"v", "\"version\":\"\\\\ud800v");
        assertThat(text).contains("\\ud800");
        Http.Reply reply = put(FORM, bytes(text));
        assertThat(reply.status()).isEqualTo(400);
        assertThat(reply.code()).isEqualTo("bad_document");
        assertThat(kernel.checks()).isEmpty();
        assertThat(repository.saves()).isZero();
    }

    @Test
    void theDatumUiGroupDocumentsTheWritesOnly() {
        Http.Reply docs = send("GET", "/v3/api-docs/datum-ui", null);
        assertThat(docs.status()).isEqualTo(200);
        JsonNode paths = docs.json().get("paths");
        assertThat(paths.get("/api/forms").has("post")).isTrue();
        assertThat(paths.get("/api/forms").has("get")).isFalse();
        assertThat(paths.get("/api/forms/{key}").has("put")).isTrue();
        assertThat(paths.get("/api/forms/{key}/translations").has("put")).isTrue();
        assertThat(paths.get("/api/forms/{key}/translations").has("get")).as("the read is the forms group's").isFalse();
        assertThat(paths.has("/api/forms/{key}/definition")).isFalse();
        JsonNode save = paths.get("/api/forms/{key}").get("put");
        assertThat(save.get("responses").has("409")).isTrue();
        assertThat(save.get("responses").has("422")).isTrue();
        assertThat(save.get("responses").has("413")).isTrue();
        assertThat(save.get("responses").has("503")).isTrue();
    }

    /** The document holds to the library's endpoint catalog (integrations/jvm/README.md "Libraries and bindings"), on this stack. */
    @Test
    void theDocumentHoldsToTheEndpointCatalog() {
        JsonNode doc = send("GET", "/v3/api-docs/datum-ui", null).json();
        java.util.Map<com.argusvane.datum.web.openapi.DatumEndpointCatalog.Base, String> bases = java.util.Map.of(com.argusvane.datum.web.openapi.DatumEndpointCatalog.Base.API, "/api");
        assertThat(com.argusvane.datum.web.openapi.DatumEndpointCatalog.differences(doc, bases)).isEmpty();
        assertThat(com.argusvane.datum.web.openapi.DatumEndpointCatalog.missing(doc, "ui", bases, endpoint -> true)).isEmpty();
    }
}
