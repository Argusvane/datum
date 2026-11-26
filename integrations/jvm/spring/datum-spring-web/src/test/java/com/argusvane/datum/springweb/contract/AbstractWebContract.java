package com.argusvane.datum.springweb.contract;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * What Datum's web plumbing answers, the same on both stacks. A subclass supplies the application (annotated
 * controllers on MVC, router functions on WebFlux) and the two ways of reaching it; this class holds the
 * expectations so the stacks cannot drift apart.
 *
 * <p>The applications serve {@code GET /test/throw/{kind}}, {@code POST /test/echo} (reads the body with the
 * Datum reader; body cap 1 KB), the assets from the test manifest (build id {@code testbuild1}, journeys
 * omitted, {@code datum-builder.js} withheld) and an application route {@code /app/boom} of their own.
 */
public abstract class AbstractWebContract {

    protected static final JsonMapper JSON = JsonMapper.builder().build();

    /** A reply, stack-neutral. */
    public record Reply(int status, HttpHeaders headers, byte[] body) {

        public String text() {
            return new String(body, java.nio.charset.StandardCharsets.UTF_8);
        }

        public JsonNode json() {
            return JSON.readTree(body);
        }

        public String code() {
            return json().get("errors").get(0).get("code").asString();
        }
    }

    protected abstract Reply get(String path);

    protected abstract Reply post(String path, String contentType, byte[] body);

    /** The reply of the application's own failing route (its own advice, or the stack's default handling). */
    protected abstract void applicationErrorsAreNotCaptured();

    private Reply throwing(String kind) {
        return get("/test/throw/" + kind);
    }

    @Test
    void sandboxFailuresAnswerTheCatalogsCodes() {
        Reply busy = throwing("busy");
        assertThat(busy.status()).isEqualTo(503);
        assertThat(busy.code()).isEqualTo("server.busy");
        assertThat(busy.headers().getFirst("Retry-After")).isEqualTo("5");
        assertThat(busy.headers().getFirst("Cache-Control")).isEqualTo("no-store");
        assertThat(busy.headers().getContentType().toString()).startsWith("application/json");

        for (String kind : List.of("unavailable", "interrupted")) {
            Reply unavailable = throwing(kind);
            assertThat(unavailable.status()).as(kind).isEqualTo(503);
            assertThat(unavailable.code()).as(kind).isEqualTo("server.unavailable");
        }
        Reply budget = throwing("budget");
        assertThat(budget.status()).isEqualTo(503);
        assertThat(budget.headers().getFirst("Retry-After")).isNull();
        assertThat(budget.code()).isEqualTo("wasm.execution_error");
        assertThat(budget.text()).doesNotContain("SECRET");
        assertThat(throwing("outcomeTooLarge").code()).isEqualTo("outcome_too_large");
        assertThat(throwing("outcomeTooLarge").status()).isEqualTo(503);
        assertThat(throwing("tooCostly").code()).isEqualTo("definition.tooCostly");
        assertThat(throwing("tooCostly").status()).isEqualTo(422);
        assertThat(throwing("tooDeep").code()).isEqualTo("definition.tooDeep");
        assertThat(throwing("tooDeep").status()).isEqualTo(422);
        Reply tooLarge = throwing("tooLarge");
        assertThat(tooLarge.status()).isEqualTo(413);
        assertThat(tooLarge.code()).isEqualTo("bad_document");
    }

    @Test
    void errorDetailsAndFrameworkErrorsUseTheErrorsShape() {
        Reply rejected = throwing("rejected");
        assertThat(rejected.status()).isEqualTo(422);
        assertThat(rejected.headers().getFirst("X-Test")).isEqualTo("yes");
        assertThat(rejected.json().get("errors")).hasSize(2);
        assertThat(rejected.json().get("currentSha256").asString()).isEqualTo("abc");
        Reply notFound = throwing("notFound");
        assertThat(notFound.status()).isEqualTo(404);
        assertThat(notFound.code()).isEqualTo("not_found");
    }

    @Test
    void unknownFailuresAreInternalAndNeverLeakTheirMessage() {
        Reply unknown = throwing("unknown");
        assertThat(unknown.status()).isEqualTo(500);
        assertThat(unknown.code()).isEqualTo("internal");
        assertThat(unknown.headers().getFirst("X-Datum-Correlation-Id")).hasSize(12);
        assertThat(unknown.text()).doesNotContain("secret");
    }

    @Test
    void theBodyReaderAppliesTheOrderMediaTypeCapParse() {
        Reply ok = post("/test/echo", "application/json", "{\"a\":1,\"b\":2}".getBytes());
        assertThat(ok.status()).isEqualTo(200);
        assertThat(ok.json().get("size").asInt()).isEqualTo(2);

        Reply wrongType = post("/test/echo", "text/plain", "{}".getBytes());
        assertThat(wrongType.status()).isEqualTo(415);
        assertThat(wrongType.code()).isEqualTo("unsupported_media_type");

        Reply tooLarge = post("/test/echo", "application/json", ("{\"s\":\"" + "x".repeat(2000) + "\"}").getBytes());
        assertThat(tooLarge.status()).isEqualTo(413);
        assertThat(tooLarge.code()).isEqualTo("bad_document");

        Reply notJson = post("/test/echo", "application/json", "{\"a\":1} trailing".getBytes());
        assertThat(notJson.status()).isEqualTo(400);
        assertThat(notJson.code()).isEqualTo("bad_document");
        // The media type is judged before the size: a huge text body is a 415, not a 413.
        assertThat(post("/test/echo", "text/plain", new byte[5000]).status()).isEqualTo(415);
    }

    @Test
    void versionedAssetsAreCachedForever() {
        Reply form = get("/datum/assets/testbuild1/datum-form.js");
        assertThat(form.status()).isEqualTo(200);
        // Spring's resource handler writes the directives in its own order; the set is what matters.
        assertThat(form.headers().getFirst("Cache-Control")).contains("max-age=31536000").contains("public").contains("immutable");
        assertThat(form.headers().getContentType().toString()).startsWith("text/javascript");
        assertThat(form.text()).contains("export const form");
        Reply nested = get("/datum/assets/testbuild1/sub/data.json");
        assertThat(nested.status()).isEqualTo(200);
        assertThat(nested.headers().getContentType().toString()).startsWith("application/json");
        // A chunk of a feature that was not omitted still serves.
        assertThat(get("/datum/assets/testbuild1/datum-webauthn-chunk.js").status()).isEqualTo(200);
    }

    @Test
    void wrongBuildMissingOmittedAndWithheldFilesAre404() {
        assertThat(get("/datum/assets/otherbuild/datum-form.js").status()).isEqualTo(404);
        assertThat(get("/datum/assets/testbuild1/nope.js").status()).isEqualTo(404);
        assertThat(get("/datum/assets/testbuild1/sub").status()).isEqualTo(404);
        assertThat(get("/datum/assets/testbuild1/datum-journey-chunk.js").status()).as("omitted feature").isEqualTo(404);
        assertThat(get("/datum/assets/testbuild1/datum-builder.js").status()).as("withheld").isEqualTo(404);
        assertThat(get("/datum/assets/testbuild1/%2e%2e/manifest.json").status()).isEqualTo(404);
        assertThat(get("/datum/assets/testbuild1/..%2fmanifest.json").status()).isEqualTo(404);
    }

    @Test
    void hostJsonIsNotCachedAndNamesTheBuild() {
        Reply host = get("/datum/assets/host.json");
        assertThat(host.status()).isEqualTo(200);
        assertThat(host.headers().getFirst("Cache-Control")).contains("no-store");
        JsonNode body = host.json();
        assertThat(body.get("buildId").asString()).isEqualTo("testbuild1");
        assertThat(body.get("assetsBase").asString()).isEqualTo("/datum/assets/testbuild1");
        assertThat(body.get("apiBase").asString()).isEqualTo("/api");
        assertThat(body.get("csrf").get("headerName").asString()).isEqualTo("X-XSRF-TOKEN");
    }

    @Test
    void theGlueScriptIsServed() {
        Reply glue = get("/datum/assets/datum-host.js");
        assertThat(glue.status()).isEqualTo(200);
        assertThat(glue.headers().getContentType().toString()).startsWith("text/javascript");
        assertThat(glue.text()).contains("DatumHost").contains("host.json");
    }

    @Test
    void theApplicationsOwnHandlersAreLeftAlone() {
        applicationErrorsAreNotCaptured();
    }
}
