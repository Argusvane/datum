package com.argusvane.datum.examples.passkeys;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.starter.test.DatumTck;
import com.argusvane.datum.tck.HostTarget;
import com.argusvane.datum.tck.PasskeysContract;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.MethodOrderer;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestMethodOrder;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

/**
 * The story end to end on the real sandbox runtime and the SQL stores (H2, Datum's V400 script run by Flyway): a
 * signed-in person makes a passkey through the endpoints, signs the petition with it, the server accepts the
 * signed submission, refuses the same document again, refuses a changed one, and refuses the signature of a passkey
 * that was removed. The authenticator is a software one; a browser does the same with a real one. The endpoints' wire
 * contract without an authenticator (the signing block, who may ask for a challenge, the register refusals in order)
 * is the host test kit's passkeys contract, run here as ada and grace after the story.
 */
@Tag("real-runtime")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
    // The software authenticator is an http://localhost origin; the application's own origin carries its port.
    "datum.webauthn.origins=http://localhost"})
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class PasskeysExampleIT implements PasskeysContract {

    private static final JsonMapper JSON = JsonMapper.builder().build();
    private static final String STATEMENT = "I confirm that these answers are mine.";

    @LocalServerPort
    int port;

    @Autowired
    JdbcTemplate jdbc;

    /** Makes the application's handler throw once, as a database that is down would. */
    private static final java.util.concurrent.atomic.AtomicBoolean FAIL_NEXT = new java.util.concurrent.atomic.AtomicBoolean();

    /** The statuses of every SubmissionSignatureVerifiedEvent, in order. */
    private static final java.util.List<String> VERIFIED = new java.util.concurrent.CopyOnWriteArrayList<>();

    @org.springframework.boot.test.context.TestConfiguration(proxyBeanMethods = false)
    static class FailingHandler {

        @org.springframework.context.event.EventListener
        void verified(com.argusvane.datum.webauthn.events.SubmissionSignatureVerifiedEvent event) {
            VERIFIED.add(event.status());
        }

        @org.springframework.context.annotation.Bean
        static org.springframework.beans.factory.config.BeanPostProcessor failOnce() {
            return new org.springframework.beans.factory.config.BeanPostProcessor() {
                @Override
                public Object postProcessAfterInitialization(Object bean, String name) {
                    if (!(bean instanceof com.argusvane.datum.submissions.spi.SubmissionHandler handler)) {
                        return bean;
                    }
                    return (com.argusvane.datum.submissions.spi.SubmissionHandler) submission -> {
                        if (FAIL_NEXT.getAndSet(false)) {
                            throw new IllegalStateException("The database is down.");
                        }
                        return handler.handle(submission);
                    };
                }
            };
        }
    }

    private final HttpClient client = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).build();
    private static final SoftwareAuthenticator AUTHENTICATOR = new SoftwareAuthenticator();
    private static ObjectNode signedOnce;
    /** The submit attempt {@link #signedOnce} was delivered under. */
    private static final String SIGNED_ONCE_KEY = UUID.randomUUID().toString();

    record Reply(int status, String body) {
        JsonNode json() {
            return JSON.readTree(body);
        }

        String code() {
            return json().path("errors").path(0).path("code").asString();
        }
    }

    @Override
    public HostTarget target() {
        // Spring Security's cookie CSRF on every request, HTTP Basic for the two people of SecurityConfiguration.
        return DatumTck.localBuilder(port).signingForm("petition").decorator((request, method, who) -> {
            String csrf;
            try {
                csrf = csrf();
            } catch (Exception e) {
                throw new IllegalStateException(e);
            }
            request.header("Cookie", "XSRF-TOKEN=" + csrf).header("X-XSRF-TOKEN", csrf);
            String user = switch (who) {
                case PERSON -> "ada";
                case OTHER_PERSON -> "grace";
                case VISITOR -> null;
            };
            if (user != null) {
                request.header("Authorization", "Basic " + Base64.getEncoder().encodeToString((user + ":" + user).getBytes(StandardCharsets.UTF_8)));
            }
        }).build();
    }

    private String csrf() throws Exception {
        HttpResponse<String> page = client.send(HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/")).GET().build(),
            HttpResponse.BodyHandlers.ofString());
        for (String cookie : page.headers().allValues("Set-Cookie")) {
            if (cookie.startsWith("XSRF-TOKEN=")) {
                return cookie.substring("XSRF-TOKEN=".length(), cookie.indexOf(';') < 0 ? cookie.length() : cookie.indexOf(';'));
            }
        }
        throw new AssertionError("No XSRF-TOKEN cookie.");
    }

    private Reply send(String method, String path, Object body, String user) throws Exception {
        String csrf = csrf();
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create("http://localhost:" + port + path))
            .method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(JSON.writeValueAsString(body), StandardCharsets.UTF_8))
            .header("Cookie", "XSRF-TOKEN=" + csrf).header("X-XSRF-TOKEN", csrf).header("Accept", "application/json");
        if (body != null) {
            request.header("Content-Type", "application/json");
        }
        if (user != null) {
            request.header("Authorization", "Basic " + Base64.getEncoder().encodeToString((user + ":" + user).getBytes(StandardCharsets.UTF_8)));
        }
        HttpResponse<String> response = client.send(request.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        return new Reply(response.statusCode(), response.body());
    }

    /** The receive body: the document and the key of its submit attempt (a retry of the attempt sends the same key). */
    private static Map<String, Object> delivery(ObjectNode document, String submissionKey) {
        return Map.of("document", document, "submissionKey", submissionKey);
    }

    private static Map<String, Object> delivery(ObjectNode document) {
        return delivery(document, UUID.randomUUID().toString());
    }

    private static ObjectNode envelope(String name) {
        ObjectNode envelope = JSON.createObjectNode();
        ObjectNode context = envelope.putObject("versionContext");
        context.putObject("form").put("id", "petition").put("version", "1");
        context.putObject("client").put("runtimeVersion", "x").put("rendererVersion", "x").put("schemaVersion", "1");
        ObjectNode submission = envelope.putObject("submission");
        submission.put("locale", "en");
        submission.putObject("values").put("fullName", name).put("reason", "Because I can.");
        return envelope;
    }

    @Test
    @Order(1)
    void dataMigrationRanAndThePageAsksToSignIn() throws Exception {
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM datum_passkey", Integer.class)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM datum_passkey_use", Integer.class)).isZero();

        Reply page = send("GET", "/api/webauthn/passkeys?form=petition", null, null);

        assertThat(page.status()).as(page.body()).isEqualTo(200);
        JsonNode signing = page.json().get("signing");
        assertThat(signing.get("mode").asString()).isEqualTo("required");
        assertThat(signing.get("statement").asString()).isEqualTo(STATEMENT);
        assertThat(signing.get("signIn").asBoolean()).as("visitors may not sign here").isTrue();
        assertThat(signing.get("ready").asBoolean()).isTrue();
        Reply anonymous = send("POST", "/api/webauthn/challenge", Map.of("form", "petition", "context", "submit"), null);
        assertThat(anonymous.status()).isEqualTo(403);
        assertThat(anonymous.code()).isEqualTo("signing.sign_in");
    }

    /**
     * Who may do what is Spring Security's: nobody dry-runs here (the chain refuses in Datum's JSON, 401 for a
     * visitor and 403 {@code access.denied} for a signed-in person), and nobody may use a form's Test context to make a
     * passkey (Datum's own rule, {@code signing.context}, since {@code datum.webauthn.test-roles} names no role).
     */
    @Test
    @Order(1)
    void nobodyDryRunsOrUsesTheTestContextHere() throws Exception {
        Reply dryRun = send("POST", "/api/submissions/test", Map.of("document", envelope("Ada Lovelace")), "ada");
        assertThat(dryRun.status()).as(dryRun.body()).isEqualTo(403);
        assertThat(dryRun.code()).isEqualTo("access.denied");
        Reply visitor = send("POST", "/api/submissions/test", Map.of("document", envelope("Ada Lovelace")), null);
        assertThat(visitor.status()).as(visitor.body()).isEqualTo(401);
        assertThat(visitor.code()).isEqualTo("unauthorized");
        Reply testContext = send("POST", "/api/webauthn/challenge", Map.of("form", "petition", "context", "test"), "ada");
        assertThat(testContext.status()).as(testContext.body()).isEqualTo(403);
        assertThat(testContext.code()).isEqualTo("signing.context");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM datum_passkey", Integer.class)).isZero();
    }

    @Test
    @Order(2)
    void aSignedInPersonMakesAPasskeyThroughTheEndpoints() throws Exception {
        Reply challenge = send("POST", "/api/webauthn/challenge", Map.of("form", "petition", "context", "submit"), "ada");
        assertThat(challenge.status()).as(challenge.body()).isEqualTo(200);
        JsonNode options = challenge.json();
        ObjectNode posted = JSON.createObjectNode();
        posted.put("token", options.get("token").asString());
        posted.put("form", "petition");
        posted.put("context", "submit");
        posted.put("label", "Ada's laptop");
        AUTHENTICATOR.userHandle = com.argusvane.datum.webauthn.Base64Url.decode(options.get("user").get("id").asString());
        posted.set("credential", AUTHENTICATOR.register(options.get("challenge").asString(), Map.of("userHandle", options.get("user").get("id").asString())));

        Reply registered = send("POST", "/api/webauthn/register", posted, "ada");

        assertThat(registered.status()).as(registered.body()).isEqualTo(201);
        assertThat(registered.json().get("label").asString()).isEqualTo("Ada's laptop");
        assertThat(jdbc.queryForObject("SELECT owner FROM datum_passkey", String.class)).isEqualTo("ada");
        JsonNode mine = send("GET", "/api/webauthn/passkeys", null, "ada").json().get("passkeys");
        assertThat(mine).hasSize(1);
        assertThat(send("GET", "/api/webauthn/passkeys", null, "grace").json().get("passkeys")).as("not grace's").isEmpty();
    }

    @Test
    @Order(3)
    void anUnsignedSubmissionIsRefusedAndASignedOneIsAccepted() throws Exception {
        Reply unsigned = send("POST", "/api/submissions", delivery(envelope("Ada Lovelace")), "ada");
        assertThat(unsigned.status()).as(unsigned.body()).isEqualTo(422);
        assertThat(unsigned.code()).isEqualTo("signature.required");

        signedOnce = AUTHENTICATOR.signSubmission(envelope("Ada Lovelace"), Map.of("statement", STATEMENT));
        VERIFIED.clear();
        Reply accepted = send("POST", "/api/submissions", delivery(signedOnce, SIGNED_ONCE_KEY), "ada");

        assertThat(accepted.status()).as(accepted.body()).isEqualTo(200);
        assertThat(VERIFIED).as("one valid event, for the stored document").containsExactly("valid");
        assertThat(accepted.json().get("reference").asString()).isEqualTo("PETITION-0001");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM datum_passkey_use", Integer.class)).as("the digest is claimed").isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT sign_count FROM datum_passkey", Long.class)).as("and the counter moved").isGreaterThan(0);
    }

    @Test
    @Order(4)
    void aSignedDocumentTheHandlerFailedToStoreCanBeSentAgain() throws Exception {
        // The receiver claims the digest and moves the counter just before the handler; a handler that fails must give
        // both back (as a rollback of the record's transaction would), or the person could never send this document again.
        long claimsBefore = jdbc.queryForObject("SELECT COUNT(*) FROM datum_passkey_use", Long.class);
        long counterBefore = jdbc.queryForObject("SELECT sign_count FROM datum_passkey", Long.class);
        ObjectNode document = AUTHENTICATOR.signSubmission(envelope("Bo Peep"), Map.of("statement", STATEMENT));

        VERIFIED.clear();
        FAIL_NEXT.set(true);
        String attempt = UUID.randomUUID().toString();
        Reply failed = send("POST", "/api/submissions", delivery(document, attempt), "ada");

        assertThat(failed.status()).as(failed.body()).isGreaterThanOrEqualTo(500);
        assertThat(VERIFIED).as("no valid event for a document the handler did not store").isEmpty();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM datum_passkey_use", Long.class)).as("the claim was given back").isEqualTo(claimsBefore);
        assertThat(jdbc.queryForObject("SELECT sign_count FROM datum_passkey", Long.class)).as("and so was the counter").isEqualTo(counterBefore);

        // The same attempt again: a delivery the handler did not store left its key free.
        Reply again = send("POST", "/api/submissions", delivery(document, attempt), "ada");

        assertThat(again.status()).as(again.body()).isEqualTo(200);
        assertThat(again.json().path("handled").asBoolean(false)).as("the failed delivery was not remembered as handled").isFalse();
        assertThat(VERIFIED).as("the stored retry is the one valid event").containsExactly("valid");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM datum_passkey_use", Long.class)).isEqualTo(claimsBefore + 1);
        assertThat(jdbc.queryForObject("SELECT sign_count FROM datum_passkey", Long.class)).isGreaterThan(counterBefore);
    }

    @Test
    @Order(5)
    void theSameSignedDocumentIsAnsweredOnceAndAChangedOneIsRefused() throws Exception {
        // The same attempt again (its key and its document) is a redelivery: the receiver answers the FIRST receipt
        // (handled: true) and neither calls the handler nor claims anything more. (The replay guard itself, for a document this instance has not
        // seen, is the signature check's: see datum-webauthn's SignedSubmissionSeamTest.)
        long claims = jdbc.queryForObject("SELECT COUNT(*) FROM datum_passkey_use", Long.class);
        Reply replay = send("POST", "/api/submissions", delivery(signedOnce, SIGNED_ONCE_KEY), "ada");
        assertThat(replay.status()).as(replay.body()).isEqualTo(200);
        assertThat(replay.json().get("handled").asBoolean()).isTrue();
        assertThat(replay.json().get("reference").asString()).isEqualTo("PETITION-0001");

        // The signature was made over other answers: the signed text no longer matches what arrives.
        ObjectNode changed = signedOnce.deepCopy();
        ((ObjectNode) changed.get("submission").get("values")).put("fullName", "Someone Else");
        Reply forged = send("POST", "/api/submissions", delivery(changed), "ada");
        assertThat(forged.status()).as(forged.body()).isEqualTo(422);
        assertThat(forged.code()).isEqualTo("signature.invalid");
        // Under the first attempt's key the changed document is refused before it is judged: the key was accepted with
        // another document.
        Reply reused = send("POST", "/api/submissions", delivery(changed, SIGNED_ONCE_KEY), "ada");
        assertThat(reused.status()).as(reused.body()).isEqualTo(409);
        assertThat(reused.code()).isEqualTo("submission.keyConflict");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM datum_passkey_use", Long.class)).as("nothing more was claimed").isEqualTo(claims);
    }

    @Test
    @Order(6)
    void aRemovedPasskeyCanSignNothingButWhatItSignedIsKept() throws Exception {
        String id = com.argusvane.datum.webauthn.Base64Url.encode(AUTHENTICATOR.credentialId);

        assertThat(send("DELETE", "/api/webauthn/passkeys/" + id, null, "grace").status()).as("not grace's").isEqualTo(404);
        Reply removed = send("DELETE", "/api/webauthn/passkeys/" + id, null, "ada");
        assertThat(removed.status()).as(removed.body()).isEqualTo(200);
        assertThat(removed.json().get("status").asString()).as("a stored submission names it: kept, not deleted").isEqualTo("removed");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM datum_passkey WHERE revoked IS NOT NULL AND removed IS NOT NULL AND label = ''", Integer.class)).isEqualTo(1);

        Reply late = send("POST", "/api/submissions", delivery(AUTHENTICATOR.signSubmission(envelope("Ada Again"), Map.of("statement", STATEMENT))), "ada");
        assertThat(late.status()).as(late.body()).isEqualTo(422);
        assertThat(late.code()).isEqualTo("signature.unusable");
        assertThat(send("GET", "/api/webauthn/passkeys", null, "ada").json().get("passkeys")).as("a removed passkey is not listed").isEmpty();
    }
}
