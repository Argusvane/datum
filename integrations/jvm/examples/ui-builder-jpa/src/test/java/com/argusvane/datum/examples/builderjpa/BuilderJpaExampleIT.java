package com.argusvane.datum.examples.builderjpa;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.starter.test.DatumTck;
import com.argusvane.datum.tck.AssetsContract;
import com.argusvane.datum.tck.BuilderContract;
import com.argusvane.datum.tck.HostTarget;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import org.junit.jupiter.api.MethodOrderer;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestMethodOrder;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * Story three end to end, on the real sandbox runtime (the starter's Endive engine and the shipped program): a
 * signed-in form admin saves through Spring Security's cookie CSRF, the kernel refuses a risky pattern and a
 * duplicate id before anything reaches the database, a good save lands with its ETag, snapshot and audit row, and
 * a page that fell behind is told 409. The builder's wire contract (who may save, If-Match and 409, the kernel's
 * refusals, id rules) and the assets with the builder on are the host test kit's, run as the form
 * admin "author" and the viewer "viewer"; the storage this example adds (audit rows, snapshots, the repository's own
 * conditional save) and Spring Security's CSRF check are tested here.
 */
@SpringBootTest(classes = BuilderJpaApplication.class, webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class BuilderJpaExampleIT implements BuilderContract, AssetsContract {

    private static final JsonMapper JSON = JsonMapper.builder().build();
    private static final String FORM = "/api/forms/intake";

    @LocalServerPort
    int port;

    @Autowired
    FormAuditEntries audit;

    @Autowired
    SnapshotEntities snapshots;

    @Autowired
    com.argusvane.datum.forms.FormDefinitionRepository repository;

    private final HttpClient client = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).build();

    record Reply(int status, HttpResponse<String> response) {

        String header(String name) {
            return response.headers().firstValue(name).orElse(null);
        }

        JsonNode json() {
            return JSON.readTree(response.body());
        }

        String code() {
            return json().get("errors").get(0).get("code").asString();
        }
    }

    @Override
    public HostTarget target() {
        // The cookie CSRF token on every request (a visitor's too, so the refusal tested is the authorization rule's, not the CSRF filter's),
        // HTTP Basic for the form admin and the viewer.
        return DatumTck.localBuilder(port).builderEnabled(true).buildForm("intake").decorator((request, method, who) -> {
            String csrf = csrfToken();
            request.header("X-XSRF-TOKEN", csrf).header("Cookie", "XSRF-TOKEN=" + csrf);
            String user = switch (who) {
                case PERSON -> "author";
                case OTHER_PERSON -> "viewer";
                case VISITOR -> null;
            };
            if (user != null) {
                request.header("Authorization", "Basic " + Base64.getEncoder().encodeToString((user + ":" + user).getBytes(StandardCharsets.UTF_8)));
            }
        }).build();
    }

    /** The CSRF token the application hands any visitor in its XSRF-TOKEN cookie. */
    String csrfToken() {
        Reply page = send("GET", "/", null, null, null, null);
        for (String cookie : page.response().headers().allValues("Set-Cookie")) {
            if (cookie.startsWith("XSRF-TOKEN=")) {
                return cookie.substring("XSRF-TOKEN=".length(), cookie.indexOf(';') < 0 ? cookie.length() : cookie.indexOf(';'));
            }
        }
        throw new AssertionError("No XSRF-TOKEN cookie on " + page.response().headers().map());
    }

    Reply send(String method, String path, String body, String user, String csrf, String ifMatch, String... headers) {
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create("http://localhost:" + port + path))
            .method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8));
        if (body != null) {
            request.header("Content-Type", "application/json");
        }
        if (user != null) {
            request.header("Authorization", "Basic " + Base64.getEncoder().encodeToString((user + ":" + user).getBytes(StandardCharsets.UTF_8)));
        }
        if (csrf != null) {
            request.header("X-XSRF-TOKEN", csrf).header("Cookie", "XSRF-TOKEN=" + csrf);
        }
        if (ifMatch != null) {
            request.header("If-Match", ifMatch);
        }
        for (int i = 0; i + 1 < headers.length; i += 2) {
            request.header(headers[i], headers[i + 1]);
        }
        try {
            HttpResponse<String> response = client.send(request.build(), HttpResponse.BodyHandlers.ofString());
            return new Reply(response.statusCode(), response);
        } catch (IOException e) {
            throw new AssertionError(e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new AssertionError(e);
        }
    }

    /** The author's copy and its tag. */
    Reply load() {
        Reply loaded = send("GET", FORM + "/definition?public=false", null, "author", null, null);
        assertThat(loaded.status()).isEqualTo(200);
        return loaded;
    }

    static ArrayNode content(ObjectNode definition) {
        return (ArrayNode) definition.get("root").get("children").get("content");
    }

    /** The short links the pages use answer the builder page (Boot's welcome page covers only the root), after a sign-in. */
    @Test
    void theBuilderAddressesOpenTheBuilderPage() {
        for (String path : new String[] {"/builder", "/builder/"}) {
            Reply signedIn = send("GET", path, null, "author", null, null);
            assertThat(signedIn.status()).as(path).isEqualTo(200);
            assertThat(signedIn.response().body()).contains("<datum-form-builder");
            assertThat(send("GET", path, null, null, null, null).status()).as(path + " asks for a sign-in").isIn(401, 302);
        }
    }

    /** The repository refuses a write that builds on a version another instance already replaced (FormDefinitionRepository#save(def, hash)). */
    @Test
    void theRepositoryRefusesASaveBuiltOnAnOldHash() {
        Reply loaded = load();
        ObjectNode definition = (ObjectNode) loaded.json();
        String current = com.argusvane.datum.forms.DefinitionService.hash(definition);
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> repository.save(definition, "0".repeat(64)))
            .isInstanceOfSatisfying(com.argusvane.datum.forms.FormOutdatedException.class,
                e -> assertThat(e.currentSha256()).isEqualTo(loaded.header("ETag").replace("\"", "")));
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> repository.save(definition, null))
            .isInstanceOf(com.argusvane.datum.forms.FormOutdatedException.class);
        // Built on the stored hash, the same save lands.
        assertThat(repository.save(definition, loaded.header("ETag").replace("\"", "")).sha256()).isEqualTo(current);
    }

    /**
     * Who may build is Spring Security's (framework-first): on Datum's routes a visitor is asked to sign in
     * (401 {@code unauthorized} with the Basic challenge) and the viewer is refused (403 {@code access.denied}), both in
     * Datum's JSON through DatumSecurityResponses; the author's copy is the form admin's, the public
     * copy is everyone's. Nothing is stored on a refusal.
     */
    @Test
    void theApplicationsSecurityRefusesInTheWiresShape() {
        Reply loaded = load();
        String csrf = csrfToken();

        Reply visitor = send("PUT", FORM, loaded.response().body(), null, csrf, loaded.header("ETag"));
        assertThat(visitor.status()).as(visitor.response().body()).isEqualTo(401);
        assertThat(visitor.code()).isEqualTo("unauthorized");
        assertThat(visitor.header("WWW-Authenticate")).isEqualTo("Basic realm=\"Datum builder\"");
        assertThat(visitor.header("Cache-Control")).contains("no-store");

        Reply viewer = send("PUT", FORM, loaded.response().body(), "viewer", csrf, loaded.header("ETag"));
        assertThat(viewer.status()).as(viewer.response().body()).isEqualTo(403);
        assertThat(viewer.code()).isEqualTo("access.denied");
        assertThat(viewer.header("Content-Type")).startsWith("application/json");

        assertThat(send("GET", FORM + "/definition?public=false", null, null, null, null).status()).isEqualTo(401);
        assertThat(send("GET", FORM + "/definition?public=false", null, "viewer", null, null).code()).isEqualTo("access.denied");
        assertThat(send("GET", FORM + "/definition", null, null, null, null).status()).as("the public copy is everyone's").isEqualTo(200);
        assertThat(load().header("ETag")).isEqualTo(loaded.header("ETag"));
    }

    /** A visitor and the viewer are refused by Spring Security (the kit's builder contract); so is a write without the token. */
    @Test
    void theFormAdminNeedsTheCsrfTokenToo() {
        Reply loaded = load();
        String body = loaded.response().body();

        Reply noToken = send("PUT", FORM, body, "author", null, null);
        assertThat(noToken.status()).as("Spring Security's CSRF check comes first").isEqualTo(403);
        assertThat(noToken.code()).as("in Datum's JSON on Datum's routes").isEqualTo("access.denied");

        assertThat(load().header("ETag")).isEqualTo(loaded.header("ETag"));
    }

    @Test
    void theRealKernelRefusesARiskyPatternAndNothingIsStored() {
        Reply loaded = load();
        long auditRows = audit.count();
        ObjectNode definition = (ObjectNode) loaded.json();
        ObjectNode fx = content(definition).addObject();
        fx.put("id", "fx");
        fx.put("type", "text");
        fx.putObject("configuration");
        fx.putObject("rules").putObject("visibleWhen").put("run", "both").put("formula", "matches(name, \"(a|a?)+\")");

        Reply refused = send("PUT", FORM, JSON.writeValueAsString(definition), "author", csrfToken(), loaded.header("ETag"));

        assertThat(refused.status()).as(refused.response().body()).isEqualTo(422);
        assertThat(refused.code()).isEqualTo("pattern.risky");
        assertThat(refused.json().get("kernel").get(0).get("where").asString()).isEqualTo("rules:fx:visibleWhen");
        assertThat(load().header("ETag")).as("the stored form is the one from before").isEqualTo(loaded.header("ETag"));
        assertThat(audit.count()).isEqualTo(auditRows);
    }

    @Test
    void aGoodSaveLandsWithItsSnapshotAndAuditRowAndAStalePageIsTold409() {
        Reply loaded = load();
        String before = loaded.header("ETag").replace("\"", "");
        ObjectNode definition = (ObjectNode) loaded.json();
        definition.put("version", "audit-" + System.nanoTime());
        content(definition).addObject().put("id", "phone" + System.nanoTime()).put("type", "text").putObject("configuration").put("label", "Phone");
        String csrf = csrfToken();

        Reply saved = send("PUT", FORM, JSON.writeValueAsString(definition), "author", csrf, loaded.header("ETag"));

        assertThat(saved.status()).as(saved.response().body()).isEqualTo(200);
        String sha = saved.json().get("sha256").asString();
        assertThat(saved.header("ETag")).isEqualTo("\"" + sha + "\"");
        assertThat(load().header("ETag")).isEqualTo(saved.header("ETag"));
        List<FormAuditEntry> rows = audit.findByFormKeyOrderByIdAsc("intake");
        assertThat(rows.get(rows.size() - 1).getSha256()).isEqualTo(sha);
        assertThat(rows.get(rows.size() - 1).getPreviousSha256()).isEqualTo(before);
        assertThat(snapshots.existsById(new SnapshotEntity.Id("intake", sha))).isTrue();

        Reply stale = send("PUT", FORM, JSON.writeValueAsString(definition), "author", csrf, loaded.header("ETag"));
        assertThat(stale.status()).isEqualTo(409);
        assertThat(stale.code()).isEqualTo("form.outdated");
        assertThat(stale.header("ETag")).isEqualTo(saved.header("ETag"));
    }

    @Test
    void removingALanguageDropsItsTranslationsAndSaysSo() {
        String csrf = csrfToken();
        Reply catalog = send("GET", FORM + "/translations", null, null, null, null);
        Reply translated = send("PUT", FORM + "/translations", "{\"catalog\":{\"en\":{\"components\":{\"name\":{\"label\":\"Your name\"}}},\"fr\":{\"components\":{\"name\":{\"label\":\"Votre nom\"}}}}}",
            "author", csrf, catalog.header("ETag"));
        assertThat(translated.status()).as(translated.response().body()).isEqualTo(200);

        Reply loaded = load();
        ObjectNode definition = (ObjectNode) loaded.json();
        ArrayNode locales = ((ObjectNode) definition.get("localization")).putArray("supportedLocales");
        locales.addObject().put("code", "en").put("label", "English");
        // What the builder sends for a removal: the language's entries leave the definition's own
        // translations section with the language; the host's catalog is the host's to prune.
        assertThat(definition.get("translations").get("fr").get("components").get("name").get("label").get("text").asString()).isEqualTo("Votre nom");
        ((ObjectNode) definition.get("translations")).remove("fr");
        Reply saved = send("PUT", FORM, JSON.writeValueAsString(definition), "author", csrf, loaded.header("ETag"));

        assertThat(saved.status()).as(saved.response().body()).isEqualTo(200);
        assertThat(saved.header("X-Datum-Removed-Locales")).isEqualTo("fr");
        JsonNode after = send("GET", FORM + "/translations", null, null, null, null).json().get("catalog");
        assertThat(after.has("fr")).isFalse();
        assertThat(after.get("en").get("components").get("name").get("label").asString()).isEqualTo("Your name");
        // What the server stores now, read back, not the test's own copy.
        Reply stored = load();
        assertThat(stored.header("ETag")).isEqualTo(saved.header("ETag"));
        List<String> codes = new ArrayList<>();
        stored.json().get("localization").get("supportedLocales").forEach(locale -> codes.add(locale.get("code").asString()));
        assertThat(codes).containsExactly("en");
    }
}
