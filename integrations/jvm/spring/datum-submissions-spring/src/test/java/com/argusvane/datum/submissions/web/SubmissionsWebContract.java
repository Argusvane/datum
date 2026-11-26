package com.argusvane.datum.submissions.web;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.sandbox.wasi.Termination;
import com.argusvane.datum.submissions.Fixtures;
import com.argusvane.datum.sandbox.runtime.TestRuntime;
import java.time.Duration;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * What the submissions endpoints answer, the same on both stacks. A subclass supplies the application (the MVC
 * controllers on MockMvc, the router function on a random-port Netty server); this class holds the expectations
 * so the stacks cannot drift apart. The runtime behind is {@code TestRuntime} (canned kernel answers), so every
 * status is reachable without the engine. Default configuration: submissions and validate on, test and inspect
 * off, a 16 KB body cap, one validation slot with no wait.
 */
public abstract class SubmissionsWebContract {

    protected static final String JSON = "application/json";

    /** Any method, with a Content-Type (or null), a body (or null) and request headers as name, value pairs. */
    protected abstract Reply send(String method, String path, String contentType, byte[] body, String... headers);

    protected abstract WebTestBeans.Probe probe();

    /** The API base the application was started with. */
    protected String api() {
        return "/api";
    }

    /** Whether the dry-run and inspect endpoints are switched on in this configuration. */
    protected boolean operatorEndpoints() {
        return false;
    }

    @BeforeEach
    void reset() {
        probe().reset();
        probe().runtime.hold = null;
    }

    protected Reply post(String path, byte[] body, String... headers) {
        return send("POST", api() + path, JSON, body, headers);
    }

    /** A delivery of the contact form: a submit attempt of its own (a fresh submission key). */
    protected static byte[] contactDelivery() {
        return Fixtures.delivered(Fixtures.envelope("contact", "1", "{\"name\":\"Ada\"}"));
    }

    // ------------------------------------------------------------------ submit

    @Test
    void aDeliveryIsHandledAndAnsweredWithTheReceipt() {
        Reply reply = post("/submissions", contactDelivery());
        assertThat(reply.status()).as(reply.text()).isEqualTo(200);
        assertThat(reply.headers().getContentType().toString()).startsWith(JSON);
        assertThat(reply.headers().getFirst("Cache-Control")).isEqualTo("no-store");
        JsonNode body = reply.json();
        assertThat(body.path("status").asString()).isEqualTo("accepted");
        assertThat(body.path("id").asString()).isEqualTo("id-1");
        assertThat(body.path("reference").asString()).isEqualTo("CONTACT-1");
        assertThat(body.path("receipt").path("title").asString()).isEqualTo("Thanks");
        assertThat(body.path("handled").asBoolean(true)).isFalse();
        assertThat(probe().handled).singleElement().satisfies(s -> assertThat(s.formKey()).isEqualTo("contact"));
    }

    @Test
    void theSameAttemptTwiceAnswersTheFirstReceiptHandledAndRunsTheHandlerOnce() {
        byte[] attempt = Fixtures.delivered(Fixtures.envelope("contact", "1", "{\"name\":\"Ada\"}"), "attempt-1");
        Reply first = post("/submissions", attempt);
        Reply second = post("/submissions", attempt);
        assertThat(second.status()).as(second.text()).isEqualTo(200);
        assertThat(second.json().path("handled").asBoolean(false)).isTrue();
        assertThat(second.json().path("id").asString()).isEqualTo(first.json().path("id").asString());
        assertThat(second.json().path("digest").asString()).isEqualTo(first.json().path("digest").asString());
        assertThat(second.json().path("receipt").path("title").asString()).isEqualTo("Thanks");
        assertThat(probe().handled).hasSize(1);
    }

    @Test
    void aKnownKeyWithAnotherDocumentIs409AndADeliveryWithoutAKeyIs400() {
        post("/submissions", Fixtures.delivered(Fixtures.envelope("contact", "1", "{\"name\":\"Ada\"}"), "attempt-1"));
        Reply conflict = post("/submissions", Fixtures.delivered(Fixtures.envelope("contact", "1", "{\"name\":\"Grace\"}"), "attempt-1"));
        assertThat(conflict.status()).as(conflict.text()).isEqualTo(409);
        assertThat(conflict.code()).isEqualTo("submission.keyConflict");
        Reply bare = post("/submissions", Fixtures.bytes(Fixtures.envelope("contact", "1", "{\"name\":\"Ada\"}")));
        assertThat(bare.status()).as(bare.text()).isEqualTo(400);
        assertThat(bare.code()).isEqualTo("bad_document");
        assertThat(probe().handled).hasSize(1);
    }

    @Test
    void aBodyThatIsNotJsonByItsTypeIs415BeforeItIsRead() {
        int before = probe().runtime.validations();
        Reply reply = send("POST", api() + "/submissions", "text/plain", contactDelivery());
        assertThat(reply.status()).isEqualTo(415);
        assertThat(reply.code()).isEqualTo("unsupported_media_type");
        assertThat(send("POST", api() + "/submissions", null, contactDelivery()).status()).isEqualTo(415);
        assertThat(probe().runtime.validations()).isEqualTo(before);
    }

    @Test
    void aBodyPastTheCapIs413AndNothingRuns() {
        int before = probe().runtime.validations();
        byte[] big = Fixtures.bytes("{\"document\":{\"pad\":\"" + "x".repeat(32 * 1024) + "\"}}");
        Reply reply = post("/submissions", big);
        assertThat(reply.status()).isEqualTo(413);
        assertThat(reply.code()).isEqualTo("bad_document");
        assertThat(probe().runtime.validations()).isEqualTo(before);
    }

    @Test
    void textThatIsNotJsonIsABadDocument() {
        Reply reply = post("/submissions", Fixtures.bytes("{not json"));
        assertThat(reply.status()).isEqualTo(400);
        assertThat(reply.code()).isEqualTo("bad_document");
        assertThat(post("/submissions", new byte[0]).status()).isEqualTo(400);
    }

    @Test
    void theApplicationsSecurityRefusesPerEndpointWith403() {
        Reply reply = post("/submissions", contactDelivery(), "X-Deny", "submit");
        assertThat(reply.status()).isEqualTo(403);
        assertThat(reply.code()).isEqualTo("access.denied");
        assertThat(post("/submissions", contactDelivery(), "X-Deny", "validate,test,build").status()).as("other operations are not submit").isEqualTo(200);
        assertThat(probe().handled).hasSize(1);
    }

    @Test
    void aPreCheckRefusesOneFormToOnePersonWithThePrincipalTheRouteAdmitted() {
        // The per-form rule is a pre-check; it must see the caller on both
        // stacks (on WebFlux the receiver runs where no thread-bound security context exists).
        int before = probe().runtime.validations();
        Reply refused = post("/submissions", contactDelivery(), "X-User", "outsider");
        assertThat(refused.status()).as(refused.text()).isEqualTo(403);
        assertThat(refused.code()).isEqualTo("access.denied");
        Reply checked = post("/submissions/validate", Fixtures.check(Fixtures.envelope("contact", "1", "{\"name\":\"Ada\"}"), "journey", null),
            "X-User", "outsider");
        assertThat(checked.status()).as(checked.text()).isEqualTo(403);
        assertThat(checked.code()).isEqualTo("access.denied");
        assertThat(probe().handled).isEmpty();
        assertThat(probe().runtime.validations()).as("a refused request costs no run").isEqualTo(before);
        Reply otherForm = post("/submissions/validate", tripCheck("2", "{\"name\":\"Ada\"}", "journey", null), "X-User", "outsider");
        assertThat(otherForm.status()).as("another form: " + otherForm.text()).isEqualTo(200);
        Reply otherPerson = post("/submissions", contactDelivery(), "X-User", "ada");
        assertThat(otherPerson.status()).as("another person: " + otherPerson.text()).isEqualTo(200);
        assertThat(probe().handled).singleElement().satisfies(s -> assertThat(s.principal().getName()).isEqualTo("ada"));
    }

    /** A pre-check names a code and words; the route answers the status the application's mapping names. */
    @Test
    void theRouteAnswersAPreCheckRefusalWithTheMappedStatus() {
        Reply refused = post("/submissions", contactDelivery(), "X-User", "spammer");
        assertThat(refused.status()).as(refused.text()).isEqualTo(451);
        assertThat(refused.code()).isEqualTo("spam.honeypot");
        assertThat(probe().handled).isEmpty();
    }

    @Test
    void anUnknownFormIs404WithoutEchoingTheId() {
        Reply reply = post("/submissions", Fixtures.delivered(Fixtures.envelope("nobody-home", "1", "{}")));
        assertThat(reply.status()).isEqualTo(404);
        assertThat(reply.code()).isEqualTo("form.notFound");
        assertThat(reply.text()).doesNotContain("nobody-home");
    }

    @Test
    void aStaleVersionIs409FormOutdated() {
        int before = probe().runtime.validations();
        Reply reply = post("/submissions", Fixtures.delivered(Fixtures.envelope("contact", "0", "{\"name\":\"Ada\"}")));
        assertThat(reply.status()).isEqualTo(409);
        assertThat(reply.code()).isEqualTo("form.outdated");
        assertThat(probe().runtime.validations()).isEqualTo(before);
    }

    @Test
    void theKernelsErrorsAreA422WithTheirFieldsAndCodes() {
        probe().runtime.outcome = context -> TestRuntime.described(Fixtures.json("{\"errors\":[{\"componentId\":\"name\",\"code\":\"required\"}]}"), context);
        Reply reply = post("/submissions", contactDelivery());
        assertThat(reply.status()).as(reply.text()).isEqualTo(422);
        JsonNode error = reply.json().get("errors").get(0);
        assertThat(error.get("field").asString()).isEqualTo("name");
        assertThat(error.get("code").asString()).isEqualTo("required");
        assertThat(probe().handled).isEmpty();
    }

    @Test
    void aThrottledRequestIs429WithRetryAfterAndRunsNoSandbox() {
        int before = probe().runtime.validations();
        probe().throttled = Duration.ofSeconds(30);
        Reply reply = post("/submissions", contactDelivery());
        assertThat(reply.status()).isEqualTo(429);
        assertThat(reply.code()).isEqualTo("flood");
        assertThat(reply.headers().getFirst("Retry-After")).isEqualTo("30");
        assertThat(probe().runtime.validations()).isEqualTo(before);
    }

    @Test
    void aBodyThatDoesNotParseIsCountedByTheAddressLimitBeforeItIsRead() {
        Reply reply = post("/submissions", Fixtures.bytes("{"));
        assertThat(reply.status()).as(reply.text()).isEqualTo(400);
        assertThat(reply.code()).isEqualTo("bad_document");
        assertThat(probe().addressesCounted).as("counted though the body never parsed").hasSize(1);
        assertThat(probe().formsChecked).as("the per-form throttle needs the parse").isEmpty();
        assertThat(post("/submissions/validate", Fixtures.bytes("{")).status()).isEqualTo(400);
        assertThat(probe().addressesCounted).as("every throttled route counts").hasSize(2);
        assertThat(probe().addressesCounted.get(0)).isEqualTo(probe().addressesCounted.get(1));
    }

    /** The routes the address limit counts: submit, validate and, where the operator endpoints are on, the dry run. */
    private String[] countedRoutes() {
        return operatorEndpoints()
            ? new String[] {"/submissions", "/submissions/validate", "/submissions/test"}
            : new String[] {"/submissions", "/submissions/validate"};
    }

    @Test
    void aRequestOverTheAddressLimitIs429FloodWithRetryAfterAndItsBodyIsNeverParsed() {
        int before = probe().runtime.validations();
        probe().addressThrottled = Duration.ofSeconds(7);
        // A body that does not parse: answered 429, not 400, so the parse never ran.
        Reply reply = post("/submissions", Fixtures.bytes("{"));
        assertThat(reply.status()).as(reply.text()).isEqualTo(429);
        assertThat(reply.code()).isEqualTo("flood");
        assertThat(reply.headers().getFirst("Retry-After")).isEqualTo("7");
        for (String path : countedRoutes()) {
            Reply other = post(path, Fixtures.bytes("{"));
            assertThat(other.status()).as(path + " " + other.text()).isEqualTo(429);
            assertThat(other.code()).isEqualTo("flood");
        }
        assertThat(probe().addressesCounted).as("a refused request is not counted").isEmpty();
        assertThat(probe().formsChecked).isEmpty();
        assertThat(probe().runtime.validations()).isEqualTo(before);
        assertThat(probe().handled).isEmpty();
    }

    @Test
    void aRequestOverTheAddressLimitIs429FloodEvenWhenItsBodyIsOverTheCap() {
        int before = probe().runtime.validations();
        probe().addressThrottled = Duration.ofSeconds(7);
        // 32 KB against a 16 KB cap: 413 if the body were read first, 429 because the address is asked before the read.
        byte[] big = Fixtures.bytes("{\"document\":{\"pad\":\"" + "x".repeat(32 * 1024) + "\"}}");
        for (String path : countedRoutes()) {
            Reply reply = post(path, big);
            assertThat(reply.status()).as(path + " " + reply.text()).isEqualTo(429);
            assertThat(reply.code()).isEqualTo("flood");
        }
        assertThat(probe().addressesCounted).as("a refused request is not counted").isEmpty();
        assertThat(probe().runtime.validations()).isEqualTo(before);
    }

    @Test
    void theContentTypeIsCheckedBeforeTheAddressLimit() {
        probe().addressThrottled = Duration.ofSeconds(7);
        Reply reply = send("POST", api() + "/submissions", "text/plain", Fixtures.bytes("{"));
        assertThat(reply.status()).isEqualTo(415);
        assertThat(reply.code()).isEqualTo("unsupported_media_type");
        assertThat(probe().addressesCounted).isEmpty();
    }

    @Test
    void aRunThatIsCutShortIs503ServerUnavailable() {
        probe().runtime.terminate = Termination.INTERRUPTED;
        Reply reply = post("/submissions", contactDelivery());
        assertThat(reply.status()).isEqualTo(503);
        assertThat(reply.code()).isEqualTo("server.unavailable");
        assertThat(probe().handled).isEmpty();
    }

    /**
     * A run the host's backstop found still going after its cancel passed its budget: 503 wasm.execution_error with no
     * Retry-After and no message, exactly as an ordinary budget stop, never server.unavailable.
     */
    @Test
    void aRunThatWouldNotStopIs503ExecutionErrorLikeAnyBudgetStop() {
        probe().runtime.terminate = Termination.BUDGET;
        Reply budget = post("/submissions", contactDelivery());
        probe().runtime.terminate = Termination.STUCK;
        Reply stuck = post("/submissions", contactDelivery());
        assertThat(stuck.status()).as(stuck.text()).isEqualTo(503).isEqualTo(budget.status());
        assertThat(stuck.code()).isEqualTo("wasm.execution_error").isEqualTo(budget.code());
        assertThat(stuck.headers().getFirst("Retry-After")).isNull();
        assertThat(stuck.json().path("errors").get(0).has("message")).as(stuck.text()).isFalse();
        assertThat(stuck.text()).isEqualTo(budget.text()).doesNotContain("Try again later");
        assertThat(probe().handled).isEmpty();
    }

    @Test
    void aBusyRuntimeIs503ServerBusyWithRetryAfterWhileTheFirstRunFinishes() throws Exception {
        CountDownLatch release = new CountDownLatch(1);
        CountDownLatch holding = new CountDownLatch(1);
        probe().runtime.hold = release;
        probe().runtime.holding = holding;
        ExecutorService pool = Executors.newSingleThreadExecutor();
        try {
            Future<Reply> first = pool.submit(() -> post("/submissions", contactDelivery()));
            assertThat(holding.await(10, TimeUnit.SECONDS)).as("the first run started").isTrue();
            Reply busy = post("/submissions", contactDelivery());
            assertThat(busy.status()).isEqualTo(503);
            assertThat(busy.code()).isEqualTo("server.busy");
            assertThat(busy.headers().getFirst("Retry-After")).isNotNull();
            release.countDown();
            assertThat(first.get(10, TimeUnit.SECONDS).status()).isEqualTo(200);
        } finally {
            release.countDown();
            pool.shutdownNow();
        }
    }

    /** An inspection takes a sandbox slot like a submission: while the only slot is held it is the same busy answer. */
    @Test
    void anInspectionWhileEverySlotIsTakenIsTheBusyAnswer() throws Exception {
        if (!operatorEndpoints()) {
            return;
        }
        CountDownLatch release = new CountDownLatch(1);
        CountDownLatch holding = new CountDownLatch(1);
        probe().runtime.hold = release;
        probe().runtime.holding = holding;
        ExecutorService pool = Executors.newSingleThreadExecutor();
        try {
            Future<Reply> first = pool.submit(() -> post("/submissions", contactDelivery()));
            assertThat(holding.await(10, TimeUnit.SECONDS)).as("the first run started").isTrue();
            for (String body : List.of("{\"form\":\"contact\"}",
                "{\"definition\":{\"id\":\"mine\",\"root\":{\"id\":\"r\",\"type\":\"form\"}},\"op\":\"public\"}")) {
                Reply busy = post("/inspect", Fixtures.bytes(body));
                assertThat(busy.status()).as(busy.text()).isEqualTo(503);
                assertThat(busy.code()).isEqualTo("server.busy");
                assertThat(busy.headers().getFirst("Retry-After")).isNotNull();
            }
            release.countDown();
            assertThat(first.get(10, TimeUnit.SECONDS).status()).isEqualTo(200);
            assertThat(post("/inspect", Fixtures.bytes("{\"form\":\"contact\"}")).status()).isEqualTo(200);
        } finally {
            release.countDown();
            pool.shutdownNow();
        }
    }

    @Test
    void aWrongMethodIs405WithAllowPost() {
        Reply reply = send("GET", api() + "/submissions", null, null);
        assertThat(reply.status()).isEqualTo(405);
        assertThat(reply.headers().getFirst("Allow")).contains("POST");
        assertThat(send("GET", api() + "/submissions/validate", null, null).status()).isEqualTo(405);
    }

    // ------------------------------------------------------------------ validate

    /** A check body for the "trip" form (one journey "main"), the journey named as the browser names it. */
    protected static byte[] tripCheck(String version, String values, String scope, String pageId) {
        ObjectNode document = Fixtures.envelope("trip", version, values);
        ((ObjectNode) document.get("submission")).set("journey", Fixtures.json("{\"id\":\"main\"}"));
        return Fixtures.check(document, scope, pageId);
    }

    @Test
    void aJourneyCheckAnswersTheSuitesVerdict() {
        Reply reply = post("/submissions/validate", tripCheck("2", "{\"name\":\"Ada\"}", "journey", null));
        assertThat(reply.status()).as(reply.text()).isEqualTo(200);
        assertThat(reply.json().get("accepted").asBoolean()).as(reply.text()).isTrue();
        assertThat(reply.json().get("errors").size()).isZero();
        assertThat(probe().handled).as("a check stores nothing").isEmpty();

        probe().runtime.outcome = context -> TestRuntime.described(Fixtures.json("{\"errors\":[{\"componentId\":\"name\",\"code\":\"required\"}],"
            + "\"pageComponentIds\":[\"name\"]}"), context);
        Reply rejected = post("/submissions/validate", tripCheck("2", "{}", "page", "p1"));
        assertThat(rejected.status()).as(rejected.text()).isEqualTo(200);
        assertThat(rejected.json().get("accepted").asBoolean()).isFalse();
        assertThat(rejected.json().get("errors").get(0).get("code").asString()).isEqualTo("required");
        assertThat(rejected.json().get("errors").get(0).get("field").asString()).isEqualTo("name");
    }

    /** The verdict's one wire shape: errors block and name no severity, notes carry the rest, no member is null. */
    @Test
    void aVerdictKeepsBlockingFindingsInErrorsAndTheRestInNotes() {
        probe().runtime.outcome = context -> TestRuntime.described(Fixtures.json("{\"errors\":[{\"componentId\":\"name\",\"code\":\"required\"},"
            + "{\"code\":\"form.level\"},{\"componentId\":\"city\",\"code\":\"hint\",\"severity\":\"warning\"}],"
            + "\"pageComponentIds\":[\"name\"]}"), context);
        Reply reply = post("/submissions/validate", tripCheck("2", "{}", "journey", null));
        assertThat(reply.status()).as(reply.text()).isEqualTo(200);
        assertThat(reply.json().get("accepted").asBoolean()).isFalse();
        JsonNode errors = reply.json().get("errors");
        assertThat(errors.size()).isEqualTo(2);
        assertThat(errors.get(0).toString()).isEqualTo("{\"field\":\"name\",\"code\":\"required\"}");
        assertThat(errors.get(1).toString()).as("no field member when the finding names none").isEqualTo("{\"code\":\"form.level\"}");
        assertThat(reply.json().get("notes").toString()).isEqualTo("[{\"field\":\"city\",\"code\":\"hint\",\"severity\":\"warning\"}]");

        // Nothing to say: no notes member at all.
        probe().runtime.outcome = TestRuntime::accepting;
        Reply clean = post("/submissions/validate", tripCheck("2", "{\"name\":\"Ada\"}", "journey", null));
        assertThat(clean.json().has("notes")).isFalse();
        assertThat(clean.json().get("errors").size()).isZero();
    }

    /**
     * The sandbox's own message (the form's authored or translated words for a rule) rides on the wire as it came: on a
     * check's 200 and on a delivery's 422, beside the field and code. A finding the sandbox gave no message for has no
     * {@code message} member, and a form-level one has no {@code field} member: no host adds words, and a hook's message
     * belongs to the finding that hook raised, never to the sandbox's (a validator's error is its own entry).
     */
    @Test
    void theSandboxsMessageIsRelayedOnAVerdictAndOnARejectionAndNoFieldIsNull() {
        probe().runtime.outcome = context -> TestRuntime.described(Fixtures.json("{\"errors\":[{\"componentId\":\"name\",\"code\":\"required\","
            + "\"message\":\"Say your name.\"},{\"code\":\"form.level\",\"message\":\"Fix the form.\"},{\"componentId\":\"city\",\"code\":\"min\"}],"
            + "\"pageComponentIds\":[\"name\"]}"), context);
        Reply verdict = post("/submissions/validate", tripCheck("2", "{}", "journey", null));
        assertThat(verdict.status()).as(verdict.text()).isEqualTo(200);
        assertThat(verdict.json().get("errors").toString()).isEqualTo("[{\"field\":\"name\",\"code\":\"required\",\"message\":\"Say your name.\"},"
            + "{\"code\":\"form.level\",\"message\":\"Fix the form.\"},{\"field\":\"city\",\"code\":\"min\"}]");

        Reply rejected = post("/submissions", Fixtures.delivered(Fixtures.envelope("trip", "2", "{}")));
        assertThat(rejected.status()).as(rejected.text()).isEqualTo(422);
        assertThat(rejected.json().get("errors").toString()).isEqualTo("[{\"field\":\"name\",\"code\":\"required\",\"message\":\"Say your name.\"},"
            + "{\"code\":\"form.level\",\"message\":\"Fix the form.\"},{\"field\":\"city\",\"code\":\"min\"}]");

        // A failure names no field either: one rule for every error body.
        probe().runtime.terminate = Termination.TRAP;
        Reply failed = post("/submissions", Fixtures.delivered(Fixtures.envelope("trip", "2", "{}")));
        assertThat(failed.status()).as(failed.text()).isEqualTo(503);
        assertThat(failed.text()).doesNotContain("\"field\"");
    }

    /**
     * A run that failed is no verdict: a check answers it as a delivery does, never as a 200 with a code in errors, and both
     * are 503 (the server's failure; no Retry-After, which only server.busy carries), never a 422 about the answers.
     */
    @Test
    void aCheckWhoseRunFailedAnswersTheStatusADeliveryDoes() {
        probe().runtime.terminate = Termination.TRAP;
        Reply failed = post("/submissions/validate", tripCheck("2", "{}", "journey", null));
        Reply delivered = post("/submissions", Fixtures.delivered(Fixtures.envelope("trip", "2", "{}")));
        assertThat(failed.status()).as(failed.text()).isEqualTo(503).isEqualTo(delivered.status());
        assertThat(failed.headers().getFirst("Retry-After")).isNull();
        assertThat(delivered.headers().getFirst("Retry-After")).isNull();
        assertThat(failed.code()).isEqualTo("wasm.execution_error").isEqualTo(delivered.code());
        assertThat(failed.json().has("accepted")).isFalse();
        Reply page = post("/submissions/validate", tripCheck("2", "{}", "page", "p1"));
        assertThat(page.status()).as(page.text()).isEqualTo(503);
        assertThat(page.code()).isEqualTo("wasm.execution_error");

        probe().runtime.terminate = Termination.INTERRUPTED;
        Reply down = post("/submissions/validate", tripCheck("2", "{}", "journey", null));
        assertThat(down.status()).as(down.text()).isEqualTo(503);
        assertThat(down.code()).isEqualTo("server.unavailable");
        assertThat(down.json().has("accepted")).isFalse();
    }

    /**
     * The host context is the application's: its one HostContextProvider bean derives it from the Spring
     * Security principal, the run carries it on a delivery and a check, and nothing the body or the document carries is
     * read for it. With the provider supplying none the key is left out; a provider that throws is 503
     * server.unavailable, never a more lenient verdict.
     */
    @Test
    void theHostContextIsTheApplicationsFromThePrincipalNeverTheBodys() {
        probe().hostContext = "principal";
        ObjectNode forged = Fixtures.envelope("contact", "1", "{\"name\":\"Ada\"}");
        forged.putObject("hostContext").put("role", "admin");
        ObjectNode body = Fixtures.json("{}");
        body.set("document", forged);
        body.put("submissionKey", java.util.UUID.randomUUID().toString());
        body.putObject("hostContext").put("role", "admin");
        Reply delivered = post("/submissions", Fixtures.bytes(body), "X-User", "editor");
        assertThat(delivered.status()).as(delivered.text()).isEqualTo(200);
        assertThat(lastRunContext().get("hostContext").toString()).isEqualTo("{\"role\":\"editor\"}");

        Reply checked = post("/submissions/validate", tripCheck("2", "{\"name\":\"Ada\"}", "journey", null), "X-User", "admin");
        assertThat(checked.status()).as(checked.text()).isEqualTo(200);
        assertThat(lastRunContext().get("hostContext").toString()).isEqualTo("{\"role\":\"admin\"}");
        assertThat(probe().hostContextAsked).extracting(request -> request.mode().name()).containsExactly("SUBMIT", "VALIDATE");
        assertThat(probe().hostContextAsked.get(1).formKey()).isEqualTo("trip");
        assertThat(probe().hostContextAsked.get(1).formVersion()).isEqualTo("2");

        probe().hostContext = "off";
        post("/submissions/validate", tripCheck("2", "{\"name\":\"Ada\"}", "journey", null));
        assertThat(lastRunContext().has("hostContext")).as("no context: the lenient reading").isFalse();

        probe().hostContext = "throws";
        int runs = probe().runtime.validations();
        for (Reply refused : List.of(post("/submissions", contactDelivery()),
            post("/submissions/validate", tripCheck("2", "{\"name\":\"Ada\"}", "journey", null)))) {
            assertThat(refused.status()).as(refused.text()).isEqualTo(503);
            assertThat(refused.code()).isEqualTo("server.unavailable");
            assertThat(refused.headers().getFirst("Retry-After")).as("only server.busy carries Retry-After").isNull();
            assertThat(refused.text()).doesNotContain("directory");
        }
        assertThat(probe().runtime.validations()).as("no run without the context").isEqualTo(runs);
    }

    /** The last validation context the program read. */
    private JsonNode lastRunContext() {
        List<ObjectNode> contexts = probe().runtime.contexts();
        return contexts.get(contexts.size() - 1);
    }

    /** The request is strict: the wrapper, the scope, and a page only for a page check. */
    @Test
    void aCheckIsStrictAboutItsRequest() {
        int before = probe().runtime.validations();
        ObjectNode document = Fixtures.envelope("trip", "2", "{}");
        ((ObjectNode) document.get("submission")).set("journey", Fixtures.json("{\"id\":\"main\"}"));
        // A bare document, no wrapper.
        Reply bare = post("/submissions/validate", Fixtures.bytes(document));
        assertThat(bare.status()).as(bare.text()).isEqualTo(400);
        // No scope, or one that is neither word.
        assertThat(post("/submissions/validate", Fixtures.wrapped(document)).status()).as("no scope").isEqualTo(400);
        assertThat(post("/submissions/validate", Fixtures.check(document, "all", null)).status()).as("another scope").isEqualTo(400);
        // A page beside a whole-journey check is refused, and a page check without its page is too.
        Reply withPage = post("/submissions/validate", Fixtures.check(document, "journey", "p1"));
        assertThat(withPage.status()).as(withPage.text()).isEqualTo(400);
        assertThat(post("/submissions/validate", Fixtures.check(document, "page", null)).status()).as("page without pageId").isEqualTo(400);
        assertThat(probe().runtime.validations()).as("a refused request costs no run").isEqualTo(before);
    }

    @Test
    void aCheckRefusesWhatTheReceiverRefusesWithTheSameCodes() {
        assertThat(post("/submissions/validate", Fixtures.wrapped(Fixtures.envelope("trip", "2", "{}"))).status()).as("no scope").isEqualTo(400);
        assertThat(send("POST", api() + "/submissions/validate", "text/plain", Fixtures.bytes("{}")).status()).isEqualTo(415);
        assertThat(post("/submissions/validate", tripCheck("2", "{}", "journey", null), "X-Deny", "validate").status()).isEqualTo(403);
        assertThat(post("/submissions/validate", tripCheck("1", "{}", "journey", null)).status()).isEqualTo(409);
        assertThat(post("/submissions/validate", Fixtures.check(Fixtures.envelope("nobody-home", "1", "{}"), "journey", null)).status()).isEqualTo(404);
    }

    // ------------------------------------------------------------------ test and inspect

    @Test
    void theDryRunAndInspectRoutesFollowTheirSwitches() {
        byte[] dryRun = Fixtures.wrapped(Fixtures.envelope("contact", "1", "{\"name\":\"Ada\"}"));
        Reply test = post("/submissions/test", dryRun);
        Reply inspect = post("/inspect", Fixtures.bytes("{\"form\":\"contact\"}"));
        if (!operatorEndpoints()) {
            assertThat(test.status()).as("switched off: absent, not forbidden").isEqualTo(404);
            assertThat(inspect.status()).isEqualTo(404);
            assertThat(test.text()).doesNotContain("form.notFound", "access.denied");
            return;
        }
        assertThat(test.status()).as(test.text()).isEqualTo(200);
        assertThat(test.json().get("outcome").asString()).isEqualTo("accepted");
        assertThat(probe().handled).as("a dry run calls no handler").isEmpty();
        assertThat(post("/submissions/test", dryRun, "X-Deny", "test").status()).isEqualTo(403);
        assertThat(inspect.status()).as(inspect.text()).isEqualTo(200);
        assertThat(inspect.json().get("ok").asBoolean()).isTrue();
        assertThat(inspect.json().get("op").asString()).isEqualTo("inspect");
        assertThat(inspect.json().get("inspected").asString()).isEqualTo("contact");
    }

    @Test
    void inspectTakesAFormOrADefinitionAndNeedsPermissionToBuild() {
        if (!operatorEndpoints()) {
            return;
        }
        Reply byDefinition = post("/inspect", Fixtures.bytes("{\"definition\":{\"id\":\"mine\",\"root\":{\"id\":\"r\",\"type\":\"form\"}},\"op\":\"public\"}"));
        assertThat(byDefinition.status()).as(byDefinition.text()).isEqualTo(200);
        assertThat(byDefinition.json().get("op").asString()).isEqualTo("public");
        assertThat(byDefinition.json().get("inspected").asString()).isEqualTo("mine");

        assertThat(post("/inspect", Fixtures.bytes("{\"form\":\"contact\"}"), "X-Deny", "build").status()).isEqualTo(403);
        assertThat(post("/inspect", Fixtures.bytes("{\"form\":\"nobody-home\"}")).status()).isEqualTo(404);
        for (String bad : List.of("[]", "{}", "{\"form\":\"contact\",\"definition\":{}}", "{\"form\":3}", "{\"definition\":[]}", "{\"form\":\"contact\",\"op\":\"check\"}")) {
            Reply reply = post("/inspect", Fixtures.bytes(bad));
            assertThat(reply.status()).as(bad).isEqualTo(400);
            assertThat(reply.code()).as(bad).isIn("bad_request", "bad_document");
        }
        assertThat(send("POST", api() + "/inspect", "text/plain", Fixtures.bytes("{}")).status()).isEqualTo(415);
    }

    @Test
    void aFailingInspectBecomesTheErrorsBodyNotAnInternalError() {
        if (!operatorEndpoints()) {
            return;
        }
        Reply refused = post("/inspect", Fixtures.bytes("{\"definition\":{\"id\":\"inspect-throws\",\"root\":{\"id\":\"r\",\"type\":\"form\"}}}"));
        // A program that threw gave no answer: the server's 503 with the run's code, never a 500.
        assertThat(refused.status()).as(refused.text()).isEqualTo(503);
        assertThat(refused.code()).isEqualTo("wasm.execution_error");

        // Inspect is not throttled (an operator's route), but a runtime that is down is still a 503.
        probe().runtime.terminate = Termination.INTERRUPTED;
        Reply down = post("/inspect", Fixtures.bytes("{\"form\":\"contact\"}"));
        assertThat(down.status()).as(down.text()).isEqualTo(503);
        assertThat(down.code()).isEqualTo("server.unavailable");
    }

    // ------------------------------------------------------------------ OpenAPI

    /** The paths of the {@code datum-submissions} springdoc group. */
    protected Set<String> documentedPaths() {
        Reply doc = send("GET", "/v3/api-docs/datum-submissions", null, null);
        assertThat(doc.status()).isEqualTo(200);
        Set<String> paths = new TreeSet<>();
        doc.json().path("paths").propertyNames().forEach(paths::add);
        return paths;
    }

    @Test
    void theOpenApiDocumentListsExactlyTheEnabledRoutes() {
        Set<String> expected = new TreeSet<>(Set.of(api() + "/submissions", api() + "/submissions/validate"));
        if (operatorEndpoints()) {
            expected.add(api() + "/submissions/test");
            expected.add(api() + "/inspect");
        }
        assertThat(documentedPaths()).isEqualTo(expected);
    }

    @Test
    void theDocumentedOperationsCarryTheirResponsesAndDatumsCommonErrors() {
        JsonNode doc = send("GET", "/v3/api-docs/datum-submissions", null, null).json();
        JsonNode submit = doc.at("/paths/" + api().replace("/", "~1") + "~1submissions/post");
        assertThat(submit.isMissingNode()).isFalse();
        assertThat(submit.get("operationId").asString()).isEqualTo("submitSubmission");
        assertThat(submit.get("tags").get(0).asString()).isEqualTo("datum-submissions");
        assertThat(submit.get("requestBody").isMissingNode()).isFalse();
        assertThat(submit.get("responses").propertyNames()).contains("200", "403", "404", "409", "400", "413", "415", "422", "429", "500", "503");
        assertThat(doc.at("/components/schemas").propertyNames()).contains("ErrorsBody");
    }

    /** The document holds to the library's endpoint catalog, on this stack. */
    @Test
    void theDocumentHoldsToTheEndpointCatalog() {
        JsonNode doc = send("GET", "/v3/api-docs/datum-submissions", null, null).json();
        java.util.Map<com.argusvane.datum.web.openapi.DatumEndpointCatalog.Base, String> bases = java.util.Map.of(com.argusvane.datum.web.openapi.DatumEndpointCatalog.Base.API, api());
        assertThat(com.argusvane.datum.web.openapi.DatumEndpointCatalog.differences(doc, bases)).isEmpty();
        assertThat(com.argusvane.datum.web.openapi.DatumEndpointCatalog.missing(doc, "submissions", bases, endpoint -> operatorEndpoints()
            || endpoint.operationId().equals("submitSubmission") || endpoint.operationId().equals("validateSubmission"))).isEmpty();
    }
}
