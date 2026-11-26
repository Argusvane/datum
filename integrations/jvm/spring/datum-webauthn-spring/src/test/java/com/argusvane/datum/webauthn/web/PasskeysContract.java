package com.argusvane.datum.webauthn.web;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.web.monitoring.DatumCapabilities;
import com.argusvane.datum.web.monitoring.DatumHealthContributors;
import com.argusvane.datum.webauthn.PasskeyRecord;
import com.argusvane.datum.webauthn.PasskeyRepository;
import com.argusvane.datum.webauthn.WebAuthnTestKit.Authenticator;
import com.argusvane.datum.webauthn.events.PasskeyRegisteredEvent;
import com.argusvane.datum.webauthn.events.PasskeyRevokedEvent;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Map;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * Every passkey endpoint and every status it answers, on both stacks (the subclasses supply the transport). The
 * application signs the forms {@code petition} and {@code private} (required), the policy lets anyone submit to
 * {@code petition}, nobody to {@code private}, and only {@code tester} and {@code admin} test; anonymous visitors
 * may make passkeys; the stores are the in-memory ones (acknowledged).
 */
public abstract class PasskeysContract extends PasskeysSupport {

    // ------------------------------------------------------------------------------------------ challenge

    @Test
    void aChallengeIsWhatTheEngineReads() {
        Reply reply = post("/challenge", body("petition", "submit"), null);

        assertThat(reply.status()).isEqualTo(200);
        assertThat(reply.headers().getFirst("Cache-Control")).isEqualTo("no-store");
        assertThat(reply.headers().getFirst("Content-Type")).startsWith("application/json");
        JsonNode options = reply.json();
        assertThat(options.get("challenge").asString()).isNotEmpty();
        assertThat(options.get("token").asString()).isNotEmpty();
        assertThat(options.get("expires").asLong()).isGreaterThan(System.currentTimeMillis() / 1000);
        assertThat(options.get("rp").get("id").asString()).isEqualTo("localhost");
        assertThat(options.get("rp").get("name").asString()).isNotEmpty();
        assertThat(options.get("user").get("id").asString()).isNotEmpty();
        assertThat(options.get("user").get("name").asString()).endsWith("signer");
        assertThat(options.get("userVerification").asString()).isEqualTo("preferred");
        assertThat(options.get("residentKey").asString()).isEqualTo("required");
        assertThat(options.get("attestation").asString()).isEqualTo("none");
        assertThat(options.get("excludeCredentials")).isEmpty();
        assertThat(options.get("pubKeyCredParams").get(0).get("type").asString()).isEqualTo("public-key");
        assertThat(options.get("pubKeyCredParams").get(0).get("alg").asInt()).isEqualTo(-7);
        assertThat(options.get("pubKeyCredParams").get(1).get("alg").asInt()).isEqualTo(-257);
    }

    @Test
    void aVisitorsHandleIsNewEachTimeAndNeverTheirName() {
        String first = post("/challenge", body("petition", null), null).json().get("user").get("id").asString();
        String second = post("/challenge", body("petition", null), null).json().get("user").get("id").asString();

        assertThat(first).isNotEqualTo(second);
    }

    @Test
    void aFormThatDoesNotSignIsNotFound() {
        Reply reply = post("/challenge", body("survey", "submit"), null);

        assertThat(reply.status()).isEqualTo(404);
        assertThat(reply.code()).isEqualTo("signing.off");
        assertThat(reply.message()).isEqualTo("This form is not signed.");
    }

    @Test
    void aKeyThatIsNotAKeyIsNotFoundWithoutEchoingIt() {
        Reply reply = post("/challenge", body("<script>alert(1)</script>", "submit"), null);

        assertThat(reply.status()).isEqualTo(404);
        assertThat(reply.code()).isEqualTo("form.notFound");
        assertThat(reply.text()).doesNotContain("script");
    }

    /**
     * Who may reach the routes is the application's security; the context stays Datum's: submit and amend
     * for anyone admitted, test only for the roles of {@code datum.webauthn.test-roles}, anything else refused.
     */
    @Test
    void theTestContextIsForTheNamedTestersOnly() {
        assertThat(post("/challenge", body("petition", "test"), null).code()).as("anonymous may not test").isEqualTo("signing.context");
        assertThat(post("/challenge", body("petition", "test"), "ada").status()).isEqualTo(403);
        assertThat(post("/challenge", body("petition", "bogus"), null).code()).isEqualTo("signing.context");
        assertThat(post("/challenge", body("petition", "test"), "tester").status()).isEqualTo(200);
        assertThat(post("/challenge", body("petition", "amend"), null).status()).as("amend is for anyone the route admits").isEqualTo(200);
        assertThat(post("/challenge", body("petition", "test"), "admin").status()).isEqualTo(200);
    }

    @Test
    void aWrongShapeIsABadRequest() {
        ObjectNode wrongForm = JSON.createObjectNode();
        wrongForm.put("form", 7);
        assertThat(post("/challenge", wrongForm, null).code()).isEqualTo("passkey.bad_request");
        ObjectNode wrongContext = body("petition", null);
        wrongContext.put("context", true);
        assertThat(post("/challenge", wrongContext, null).code()).isEqualTo("passkey.bad_request");
        assertThat(post("/challenge", "[]", null).code()).isEqualTo("passkey.bad_request");
        assertThat(post("/challenge", "{not json", null).status()).isEqualTo(400);
        assertThat(post("/challenge", "{not json", null).code()).isEqualTo("bad_document");
    }

    @Test
    void theBodyRulesAreTheSharedOnes() {
        Reply notJson = send("POST", base() + "/challenge", "{}".getBytes(StandardCharsets.UTF_8), "Content-Type", "text/plain");
        assertThat(notJson.status()).isEqualTo(415);
        assertThat(send("POST", base() + "/challenge", "{}".getBytes(StandardCharsets.UTF_8)).status()).as("no Content-Type").isEqualTo(415);
        String big = "{\"form\":\"petition\",\"label\":\"" + "x".repeat(70_000) + "\"}";
        Reply tooBig = post("/challenge", big, null);
        assertThat(tooBig.status()).isEqualTo(413);
        assertThat(tooBig.code()).isEqualTo("bad_document");
    }

    @Test
    void aWrongMethodIs405() {
        assertThat(get("/challenge", null).status()).isEqualTo(405);
        assertThat(send("PUT", base() + "/register", new byte[0], "Content-Type", "application/json").status()).isEqualTo(405);
        assertThat(post("/passkeys", "{}", null).status()).isEqualTo(405);
    }

    // ------------------------------------------------------------------------------------------ the application's hooks

    /**
     * The application's {@code RegistrationCustomizer} and {@code RegistrationValidator} on the wire: a refusal is
     * its kind's status with the errors body, the validator's errors a 422 with every error in order (the field kept), a
     * throwing hook a 500 that names nothing of the cause; a refused or failed registration stores no passkey and announces
     * none.
     */
    @Test
    void theApplicationsRegistrationHooksAnswerTheirKindAndARefusedPasskeyIsNeverStored() {
        Reply closed = post("/challenge", body("petition", "submit"), "closed");
        assertThat(closed.status()).as(closed.text()).isEqualTo(403);
        assertThat(closed.code()).isEqualTo("tenant.closed");
        assertThat(closed.message()).isEqualTo("Passkeys are closed for your organization.");

        Reply down = post("/challenge", body("petition", "submit"), "hook-down");
        assertThat(down.status()).isEqualTo(500);
        assertThat(down.code()).isEqualTo("internal");
        assertThat(down.text()).doesNotContain("secret").doesNotContain("tenant directory");

        PasskeyRepository passkeys = context.getBean(PasskeyRepository.class);
        java.util.List<Object> events = context.getBean(PasskeysTestBeans.Events.class).all;
        int announced = events.size();

        Authenticator refusedKey = new Authenticator();
        Reply refused = registerWith(refusedKey, "petition", "submit", null, "policy-refuses");
        assertThat(refused.status()).as(refused.text()).isEqualTo(422);
        assertThat(refused.code()).isEqualTo("passkey.aaguid");
        assertThat(refused.json().get("errors").get(0).get("field").asString()).isEqualTo("aaguid");
        assertThat(refused.json().get("errors").get(1).get("code").asString()).isEqualTo("passkey.attestation");
        assertThat(passkeys.find(refusedKey.credentialId())).as("a refused passkey is not stored").isEmpty();

        Authenticator failedKey = new Authenticator();
        Reply failed = registerWith(failedKey, "petition", "submit", null, "policy-down");
        assertThat(failed.status()).isEqualTo(500);
        assertThat(failed.code()).isEqualTo("internal");
        assertThat(failed.text()).doesNotContain("secret").doesNotContain("AAGUID registry");
        assertThat(passkeys.find(failedKey.credentialId())).as("a passkey the policy could not judge is not stored").isEmpty();

        Authenticator conflictKey = new Authenticator();
        Reply conflict = registerWith(conflictKey, "petition", "submit", null, "tenant-conflict");
        assertThat(conflict.status()).isEqualTo(409);
        assertThat(conflict.code()).isEqualTo("tenant.limit");
        assertThat(passkeys.find(conflictKey.credentialId())).isEmpty();

        assertThat(events).as("no refused or failed passkey is announced").hasSize(announced);
    }

    // ------------------------------------------------------------------------------------------ registration

    @Test
    void aPasskeyIsRegisteredAndEverythingTheStoreKeepsIsTheAuthenticators() {
        Authenticator authenticator = new Authenticator();

        Reply reply = registerWith(authenticator, "petition", "submit", null, "Ada Lovelace");

        assertThat(reply.status()).as(reply.text()).isEqualTo(201);
        JsonNode created = reply.json();
        assertThat(created.get("id").asString()).isEqualTo(authenticator.credentialId());
        assertThat(created.get("label").asString()).isEqualTo("Ada Lovelace");
        assertThat(created.get("createdAt").asString()).isNotEmpty();
        assertThat(created.get("algorithm").asInt()).isEqualTo(-7);
        assertThat(created.get("transports").size()).isGreaterThan(0);
        assertThat(created.get("publicKey").asString()).isNotEmpty();
        PasskeyRecord stored = context.getBean(PasskeyRepository.class).find(authenticator.credentialId()).orElseThrow();
        assertThat(stored.publicKey()).isEqualTo(authenticator.spki());
        assertThat(stored.owner()).as("a visitor's passkey is anonymous").isEmpty();
        assertThat(stored.madeOn()).isEqualTo("petition");
        assertThat(stored.origin()).isEqualTo("form");
        assertThat(stored.rpId()).isEqualTo("localhost");
        assertThat(context.getBean(PasskeysTestBeans.Events.class).all).anyMatch(event ->
            event instanceof PasskeyRegisteredEvent registered && registered.credentialId().equals(authenticator.credentialId())
                && registered.formKey().equals("petition") && registered.origin().equals("form"));
    }

    @Test
    void theRegistrationNamesTheBrowserNotTheUserAgent() {
        Authenticator authenticator = new Authenticator();
        Reply challenge = post("/challenge", body("petition", "submit"), null);
        ObjectNode posted = body("petition", "submit");
        posted.put("token", challenge.json().get("token").asString());
        posted.set("credential", authenticator.credentialFor(challenge.json()));

        Reply reply = send("POST", base() + "/register", JSON.writeValueAsBytes(posted), "Content-Type", "application/json", "User-Agent",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");

        assertThat(reply.status()).isEqualTo(201);
        assertThat(context.getBean(PasskeyRepository.class).find(authenticator.credentialId()).orElseThrow().browser()).isEqualTo("Chrome on macOS");
    }

    @Test
    void aChallengeIsUsedOnce() {
        Authenticator authenticator = new Authenticator();
        Reply challenge = post("/challenge", body("petition", "submit"), null);
        assertThat(registerFrom(authenticator, challenge.json(), "petition", "submit", null, null).status()).isEqualTo(201);

        Reply again = registerFrom(authenticator, challenge.json(), "petition", "submit", null, null);

        assertThat(again.status()).isEqualTo(400);
        assertThat(again.code()).isEqualTo("passkey.challenge");
    }

    @Test
    void aChallengeForOneContextRegistersNothingInAnother() {
        Reply challenge = post("/challenge", body("petition", "submit"), null);

        Reply other = registerFrom(new Authenticator(), challenge.json(), "petition", "amend", null, null);

        assertThat(other.status()).isEqualTo(400);
        assertThat(other.code()).isEqualTo("passkey.challenge");
    }

    @Test
    void aCredentialIdOrAKeyRegistersOnce() {
        Authenticator authenticator = new Authenticator();
        assertThat(registerWith(authenticator, "petition", "submit", null, null).status()).isEqualTo(201);

        Reply sameId = registerWith(authenticator, "petition", "submit", null, null);
        assertThat(sameId.status()).isEqualTo(409);
        assertThat(sameId.code()).isEqualTo("passkey.exists");

        Reply sameKey = registerWith(authenticator.withCredentialId(new byte[] {9, 9, 9, 9, 9, 9, 9, 9}), "petition", "submit", null, null);
        assertThat(sameKey.status()).as("a key read off a signature must not come back under a new id").isEqualTo(409);
        assertThat(sameKey.code()).isEqualTo("passkey.exists");
    }

    @Test
    void aWebAuthnCheckThatFailsIs422AndStoresNothing() {
        Authenticator authenticator = new Authenticator();
        Reply challenge = post("/challenge", body("petition", "submit"), null);
        ObjectNode posted = body("petition", "submit");
        posted.put("token", challenge.json().get("token").asString());
        posted.set("credential", authenticator.credentialFor(challenge.json(), Map.of("origin", "https://evil.example")));

        Reply reply = post("/register", posted, null);

        assertThat(reply.status()).isEqualTo(422);
        assertThat(reply.code()).isEqualTo("passkey.invalid");
        assertThat(reply.message()).isEqualTo("Passkeys are not set up for this address of the site. Contact us.");
        assertThat(context.getBean(PasskeyRepository.class).find(authenticator.credentialId())).isEmpty();
    }

    @Test
    void aRegistrationThatCannotBeReadIs400() {
        ObjectNode noCredential = body("petition", "submit");
        noCredential.put("token", "abc");
        Reply reply = post("/register", noCredential, null);
        assertThat(reply.status()).isEqualTo(400);
        assertThat(reply.code()).isEqualTo("passkey.bad_request");
        assertThat(post("/register", body("petition", "submit"), null).code()).isEqualTo("passkey.bad_request");
    }

    @Test
    void aForgedTokenIsAChallengeRefusal() {
        ObjectNode forged = body("petition", "submit");
        forged.put("token", "eyJwIjoicmVnaXN0ZXIiLCJmIjoicGV0aXRpb24ifQ");
        forged.putObject("credential").put("id", "x").putObject("response");

        assertThat(post("/register", forged, null).code()).isEqualTo("passkey.challenge");
    }

    @Test
    void aSignedInPersonsPasskeysShareOneHandleAndAreExcludedFromTheNextChallenge() {
        Authenticator first = new Authenticator();
        assertThat(registerWith(first, "petition", "submit", "ada", null).status()).isEqualTo(201);

        Reply next = post("/challenge", body("petition", "submit"), "ada");

        JsonNode options = next.json();
        assertThat(options.get("excludeCredentials")).hasSize(1);
        assertThat(options.get("excludeCredentials").get(0).get("id").asString()).isEqualTo(first.credentialId());
        assertThat(options.get("user").get("name").asString()).isEqualTo("ada");
        assertThat(options.get("user").get("id").asString()).isEqualTo(context.getBean(PasskeyRepository.class)
            .find(first.credentialId()).orElseThrow().userHandle());
        PasskeyRecord stored = context.getBean(PasskeyRepository.class).find(first.credentialId()).orElseThrow();
        assertThat(stored.owner()).isEqualTo("ada");
    }

    @Test
    void aPasskeyMadeAheadOfTimeIsASignedInPersonsOnly() {
        Reply anonymous = post("/challenge", body(null, null), null);
        assertThat(anonymous.status()).isEqualTo(403);
        assertThat(anonymous.code()).isEqualTo("signing.sign_in");

        Authenticator authenticator = new Authenticator();
        Reply challenge = post("/challenge", body(null, null), "grace");
        assertThat(challenge.status()).isEqualTo(200);
        ObjectNode posted = body(null, "account");
        posted.put("token", challenge.json().get("token").asString());
        posted.set("credential", authenticator.credentialFor(challenge.json()));
        Reply registered = post("/register", posted, "grace");

        assertThat(registered.status()).as(registered.text()).isEqualTo(201);
        PasskeyRecord stored = context.getBean(PasskeyRepository.class).find(authenticator.credentialId()).orElseThrow();
        assertThat(stored.origin()).isEqualTo("account");
        assertThat(stored.formId()).as("it signs any form").isEmpty();
        assertThat(stored.owner()).isEqualTo("grace");
        assertThat(post("/challenge", body(null, "submit"), "grace").code()).as("a context needs its form").isEqualTo("passkey.bad_request");
    }

    // ------------------------------------------------------------------------------------------ the person's passkeys

    @Test
    void thePageIsToldWhatItNeedsToSignAndWhichPasskeysToOffer() {
        Authenticator authenticator = new Authenticator();
        registered(authenticator, "petition", "linus");

        Reply reply = get("/passkeys?form=petition", "linus");

        assertThat(reply.status()).isEqualTo(200);
        JsonNode answer = reply.json();
        assertThat(answer.get("passkeys")).hasSize(1);
        JsonNode reference = answer.get("passkeys").get(0);
        assertThat(reference.get("id").asString()).isEqualTo(authenticator.credentialId());
        assertThat(reference.get("algorithm").asInt()).isEqualTo(-7);
        assertThat(reference.get("publicKey").asString()).isNotEmpty();
        assertThat(reference.has("label")).as("references are what the browser needs, nothing more").isFalse();
        JsonNode signing = answer.get("signing");
        assertThat(signing.get("mode").asString()).isEqualTo("required");
        assertThat(signing.get("scope").asString()).isEqualTo("envelope");
        assertThat(signing.get("placement").asString()).isEqualTo("embedded");
        assertThat(signing.get("statement").asString()).isEqualTo("I confirm these answers.");
        assertThat(signing.get("rpId").asString()).isEqualTo("localhost");
        assertThat(signing.get("ready").asBoolean()).isTrue();
        assertThat(signing.get("register").asBoolean()).isTrue();
        assertThat(signing.get("signIn").asBoolean()).isFalse();
        assertThat(signing.get("signedIn").asBoolean()).isTrue();
        assertThat(get("/passkeys?form=petition", null).json().get("passkeys")).as("a visitor has none").isEmpty();
        assertThat(get("/passkeys?form=petition", null).json().get("signing").get("signedIn").asBoolean()).isFalse();
    }

    @Test
    void theListIsTheCallersOwnAndNoOnesElse() {
        Authenticator authenticator = new Authenticator();
        Reply made = registerWith(authenticator, "petition", "submit", "margaret", "Work laptop");
        assertThat(made.status()).isEqualTo(201);

        JsonNode mine = get("/passkeys", "margaret").json().get("passkeys");
        assertThat(mine).hasSize(1);
        assertThat(mine.get(0).get("label").asString()).isEqualTo("Work laptop");
        assertThat(mine.get(0).get("formId").asString()).isEmpty();
        assertThat(mine.get(0).get("revoked").asBoolean()).isFalse();
        assertThat(mine.get(0).get("lastUsed").isNull()).isTrue();
        assertThat(get("/passkeys", "someone-else").json().get("passkeys")).isEmpty();
        assertThat(get("/passkeys", null).json().get("passkeys")).isEmpty();
    }

    @Test
    void theListOfAFormThatDoesNotSignIsRefused() {
        assertThat(get("/passkeys?form=survey", "ada").code()).isEqualTo("signing.off");
        assertThat(get("/passkeys?form=" + "x".repeat(200), "ada").status()).isEqualTo(404);
    }

    // ------------------------------------------------------------------------------------------ remove

    @Test
    void anOwnerRemovesAPasskeyThatSignedNothing() {
        Authenticator authenticator = new Authenticator();
        String id = registered(authenticator, "petition", "dennis");

        Reply other = delete("/passkeys/" + id, "someone-else");
        assertThat(other.status()).as("not yours is not found").isEqualTo(404);
        assertThat(other.code()).isEqualTo("passkey.notFound");
        assertThat(delete("/passkeys/" + id, null).status()).isEqualTo(404);

        Reply removed = delete("/passkeys/" + id, "dennis");
        assertThat(removed.status()).isEqualTo(200);
        assertThat(removed.json().get("id").asString()).isEqualTo(id);
        assertThat(removed.json().get("status").asString()).isEqualTo("deleted");
        assertThat(context.getBean(PasskeyRepository.class).find(id)).isEmpty();
        assertThat(delete("/passkeys/" + id, "dennis").status()).isEqualTo(404);
        assertThat(context.getBean(PasskeysTestBeans.Events.class).all).anyMatch(event ->
            event instanceof PasskeyRevokedEvent revoked && revoked.credentialId().equals(id) && revoked.deleted() && revoked.by().equals("dennis"));
    }

    @Test
    void whoMayBuildMayNotRemoveSomeoneElsesPasskey() {
        String id = registered(new Authenticator(), "petition", "barbara");

        Reply reply = delete("/passkeys/" + id, "admin");

        assertThat(reply.status()).as("building rights are not ownership").isEqualTo(404);
        assertThat(context.getBean(PasskeyRepository.class).find(id)).isPresent();
    }

    // ------------------------------------------------------------------------------------------ test this passkey

    @Test
    void aPasskeyTestsAndTheCounterMoves() {
        Authenticator authenticator = new Authenticator();
        String id = registered(authenticator, "petition", "alan");

        Reply challenge = post("/passkeys/" + id + "/check-challenge", new byte[0], "alan");
        assertThat(challenge.status()).as(challenge.text()).isEqualTo(200);
        JsonNode options = challenge.json();
        assertThat(options.get("rpId").asString()).isEqualTo("localhost");
        assertThat(options.get("allowCredentials").get(0).get("id").asString()).isEqualTo(id);
        assertThat(options.get("userVerification").asString()).isEqualTo("preferred");

        ObjectNode posted = JSON.createObjectNode();
        posted.put("token", options.get("token").asString());
        posted.set("assertion", authenticator.assertionFor(options));
        Reply checked = post("/passkeys/" + id + "/check", posted, "alan");

        assertThat(checked.status()).as(checked.text()).isEqualTo(200);
        assertThat(checked.json().get("ok").asBoolean()).isTrue();
        assertThat(checked.json().get("lastUsed").asLong()).isGreaterThan(0);
    }

    @Test
    void aTestOfSomeoneElsesPasskeyOrOneThatDoesNotExistIsNotFound() {
        String id = registered(new Authenticator(), "petition", "ken");

        assertThat(post("/passkeys/" + id + "/check-challenge", new byte[0], "someone-else").code()).isEqualTo("passkey.notFound");
        assertThat(post("/passkeys/" + id + "/check-challenge", new byte[0], null).status()).isEqualTo(404);
        assertThat(post("/passkeys/nope/check-challenge", new byte[0], "ken").status()).isEqualTo(404);
        assertThat(post("/passkeys/" + id + "/check", "{}", "someone-else").status()).isEqualTo(404);
    }

    @Test
    void aTestThatDoesNotVerifyIs422() {
        Authenticator authenticator = new Authenticator();
        String id = registered(authenticator, "petition", "edsger");
        JsonNode options = post("/passkeys/" + id + "/check-challenge", new byte[0], "edsger").json();
        ObjectNode posted = JSON.createObjectNode();
        posted.put("token", options.get("token").asString());
        // Another passkey answered: the device chose wrongly.
        Authenticator other = new Authenticator();
        posted.set("assertion", other.assertionFor(options));

        Reply reply = post("/passkeys/" + id + "/check", posted, "edsger");

        assertThat(reply.status()).isEqualTo(422);
        assertThat(reply.code()).isEqualTo("passkey.check");
    }

    @Test
    void aTestWithAnOriginThatIsNotTheSitesDoesNotVerify() {
        Authenticator authenticator = new Authenticator();
        String id = registered(authenticator, "petition", "niklaus");
        JsonNode options = post("/passkeys/" + id + "/check-challenge", new byte[0], "niklaus").json();
        ObjectNode posted = JSON.createObjectNode();
        posted.put("token", options.get("token").asString());
        posted.set("assertion", authenticator.assertionFor(options, Map.of("origin", "https://evil.example")));

        Reply reply = post("/passkeys/" + id + "/check", posted, "niklaus");

        assertThat(reply.status()).isEqualTo(422);
        assertThat(reply.code()).isEqualTo("passkey.check");
        assertThat(reply.message()).startsWith("The test did not verify");
    }

    @Test
    void aCounterThatDidNotGoUpIsACopiedPasskey() {
        Authenticator authenticator = new Authenticator();
        String id = registered(authenticator, "petition", "tim");
        // A first good test records the counter (the authenticator counts 2, 3, ...).
        JsonNode first = post("/passkeys/" + id + "/check-challenge", new byte[0], "tim").json();
        ObjectNode good = JSON.createObjectNode();
        good.put("token", first.get("token").asString());
        good.set("assertion", authenticator.assertionFor(first, Map.of("counter", 5L)));
        assertThat(post("/passkeys/" + id + "/check", good, "tim").status()).isEqualTo(200);

        JsonNode second = post("/passkeys/" + id + "/check-challenge", new byte[0], "tim").json();
        ObjectNode copied = JSON.createObjectNode();
        copied.put("token", second.get("token").asString());
        copied.set("assertion", authenticator.assertionFor(second, Map.of("counter", 5L)));
        Reply reply = post("/passkeys/" + id + "/check", copied, "tim");

        assertThat(reply.status()).isEqualTo(422);
        assertThat(reply.code()).isEqualTo("passkey.counter");
    }

    @Test
    void aRevokedPasskeyCannotBeTested() {
        String id = registered(new Authenticator(), "petition", "vint");
        PasskeyRepository passkeys = context.getBean(PasskeyRepository.class);
        passkeys.revoke(passkeys.find(id).orElseThrow().id(), "admin", java.time.Instant.now());

        Reply reply = post("/passkeys/" + id + "/check-challenge", new byte[0], "vint");

        assertThat(reply.status()).isEqualTo(409);
        assertThat(reply.code()).isEqualTo("passkey.revoked");
    }

    @Test
    void aTestWithoutATokenOrAnAssertionIs400AndAUsedTokenIsRefused() {
        Authenticator authenticator = new Authenticator();
        String id = registered(authenticator, "petition", "donald");
        JsonNode options = post("/passkeys/" + id + "/check-challenge", new byte[0], "donald").json();

        assertThat(post("/passkeys/" + id + "/check", "{}", "donald").code()).isEqualTo("passkey.bad_request");
        ObjectNode posted = JSON.createObjectNode();
        posted.put("token", options.get("token").asString());
        posted.set("assertion", authenticator.assertionFor(options));
        assertThat(post("/passkeys/" + id + "/check", posted, "donald").status()).isEqualTo(200);
        Reply again = post("/passkeys/" + id + "/check", posted, "donald");
        assertThat(again.status()).isEqualTo(400);
        assertThat(again.code()).isEqualTo("passkey.challenge");
    }

    // ------------------------------------------------------------------------------------------ throttle

    @Test
    void theThrottleLimitsChallengesRegistrationsAndTests() {
        PasskeysTestBeans.SwitchedThrottle throttle = context.getBean(PasskeysTestBeans.SwitchedThrottle.class);
        String id = registered(new Authenticator(), "petition", "radia");
        throttle.wait.set(Duration.ofMillis(1500));

        Reply challenge = post("/challenge", body("petition", "submit"), null);
        assertThat(challenge.status()).isEqualTo(429);
        assertThat(challenge.code()).isEqualTo("flood");
        assertThat(challenge.headers().getFirst("Retry-After")).isEqualTo("2");
        assertThat(challenge.message()).isEqualTo("Too many passkey requests from your address. Try again later.");
        ObjectNode posted = body("petition", "submit");
        posted.put("token", "x");
        posted.putObject("credential").put("id", "x").putObject("response");
        assertThat(post("/register", posted, null).status()).isEqualTo(429);
        assertThat(post("/passkeys/" + id + "/check-challenge", new byte[0], "radia").status()).isEqualTo(429);
        assertThat(get("/passkeys?form=petition", null).status()).as("a read is not limited").isEqualTo(200);
        assertThat(throttle.seen).anyMatch(entry -> entry.equals("petition|null"));
    }

    @Test
    void aBodyThatDoesNotParseIsCountedByTheAddressLimitAndOverItIs429Unread() {
        PasskeysTestBeans.SwitchedThrottle throttle = context.getBean(PasskeysTestBeans.SwitchedThrottle.class);
        throttle.addresses.clear();
        throttle.seen.clear();
        try {
            assertThat(post("/challenge", "{".getBytes(java.nio.charset.StandardCharsets.UTF_8), null).status()).isEqualTo(400);
            assertThat(post("/register", "{".getBytes(java.nio.charset.StandardCharsets.UTF_8), null).status()).isEqualTo(400);
            assertThat(throttle.addresses).as("counted before the parse").hasSize(2);
            assertThat(throttle.seen).as("the per-form throttle needs the parse").isEmpty();
            throttle.addressWait.set(Duration.ofSeconds(4));
            Reply refused = post("/challenge", "{".getBytes(java.nio.charset.StandardCharsets.UTF_8), null);
            assertThat(refused.status()).as("429, not 400: the body was never parsed").isEqualTo(429);
            assertThat(refused.code()).isEqualTo("flood");
            assertThat(refused.headers().getFirst("Retry-After")).isEqualTo("4");
            assertThat(refused.message()).isEqualTo("Too many passkey requests from your address. Try again later.");
            assertThat(post("/register", "{".getBytes(java.nio.charset.StandardCharsets.UTF_8), null).status()).isEqualTo(429);
            assertThat(get("/passkeys?form=petition", null).status()).as("a read is not limited").isEqualTo(200);
            assertThat(throttle.addresses).as("a refused request is not counted").hasSize(2);
        } finally {
            throttle.addressWait.set(null);
        }
    }

    @Test
    void aRequestOverTheAddressLimitIs429FloodEvenWhenItsBodyIsOverTheCap() {
        PasskeysTestBeans.SwitchedThrottle throttle = context.getBean(PasskeysTestBeans.SwitchedThrottle.class);
        throttle.addresses.clear();
        throttle.seen.clear();
        try {
            throttle.addressWait.set(Duration.ofSeconds(4));
            // Over the cap: 413 if the body were read first, 429 because the address is asked before the read.
            byte[] big = ("{\"form\":\"petition\",\"label\":\"" + "x".repeat(70_000) + "\"}").getBytes(java.nio.charset.StandardCharsets.UTF_8);
            for (String path : new String[] {"/challenge", "/register"}) {
                Reply refused = post(path, big, null);
                assertThat(refused.status()).as(path + " " + refused.text()).isEqualTo(429);
                assertThat(refused.code()).isEqualTo("flood");
            }
            assertThat(throttle.addresses).as("a refused request is not counted").isEmpty();
        } finally {
            throttle.addressWait.set(null);
        }
    }

    @Test
    void aRefusedRequestIsNotCounted() {
        PasskeysTestBeans.SwitchedThrottle throttle = context.getBean(PasskeysTestBeans.SwitchedThrottle.class);
        throttle.seen.clear();

        post("/challenge", body("survey", "submit"), null);
        post("/challenge", body("petition", "test"), null);
        post("/challenge", body("petition", "bogus"), null);

        assertThat(throttle.seen).isEmpty();
    }

    // ------------------------------------------------------------------------------------------ operations

    @Test
    void healthAndInfoKnowTheCapability() {
        DatumHealthContributors.Status status = context.getBean(DatumHealthContributors.class).evaluate().get("datum-webauthn");

        assertThat(status).isNotNull();
        assertThat(status.up()).isTrue();
        assertThat(status.details()).containsEntry("replayStore", storeKind());
        assertThat(context.getBean(DatumCapabilities.class).present()).contains("webauthn");
    }

    @Test
    void theOpenApiGroupListsExactlyTheRoutes() {
        Reply doc = send("GET", "/v3/api-docs/datum-webauthn", null, "Accept", "application/json");

        assertThat(doc.status()).as(doc.text()).isEqualTo(200);
        JsonNode paths = doc.json().get("paths");
        assertThat(paths.propertyNames()).containsExactlyInAnyOrder(base() + "/challenge", base() + "/register", base() + "/passkeys",
            base() + "/passkeys/{id}", base() + "/passkeys/{id}/check-challenge", base() + "/passkeys/{id}/check");
        assertThat(paths.get(base() + "/passkeys/{id}").has("delete")).isTrue();
        assertThat(paths.get(base() + "/passkeys").has("get")).isTrue();
        assertThat(paths.get(base() + "/challenge").get("post").get("operationId").asString()).isEqualTo("passkeyChallenge");
    }

    /** The document holds to the library's endpoint catalog (integrations/jvm/README.md "Libraries and bindings"), on this stack. */
    @Test
    void theDocumentHoldsToTheEndpointCatalog() {
        JsonNode doc = send("GET", "/v3/api-docs/datum-webauthn", null, "Accept", "application/json").json();
        java.util.Map<com.argusvane.datum.web.openapi.DatumEndpointCatalog.Base, String> bases = java.util.Map.of(com.argusvane.datum.web.openapi.DatumEndpointCatalog.Base.WEBAUTHN, base());
        assertThat(com.argusvane.datum.web.openapi.DatumEndpointCatalog.differences(doc, bases)).isEmpty();
        assertThat(com.argusvane.datum.web.openapi.DatumEndpointCatalog.missing(doc, "webauthn", bases, endpoint -> true)).isEmpty();
    }
}
