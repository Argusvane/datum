package com.argusvane.datum.tck;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import java.nio.charset.StandardCharsets;
import java.util.Map;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * The passkey endpoints' wire contract, without an authenticator: the signing block a page reads, who may ask for a
 * registration challenge, the challenge's shape, the order of the register refusals (400 {@code passkey.bad_request},
 * 400 {@code passkey.challenge} for a token never issued, 422 {@code passkey.invalid} for a credential that does not
 * verify, then the token is spent), a person's own list, and 404 for a passkey that is not theirs. The host names a
 * form that asks for a signature ({@link HostTarget#signingForm()}) and makes requests as {@link HostTarget.Who#PERSON}
 * and {@link HostTarget.Who#OTHER_PERSON}. The full ceremony with a software authenticator (register, sign, replay,
 * revoke) stays in the Spring passkeys example, which also implements this contract.
 */
public interface PasskeysContract extends HostContract {

    private String path(String rest) {
        return target().webAuthnPath() + rest;
    }

    private Reply post(String rest, String json, HostTarget.Who who) {
        return http().send("POST", path(rest), "application/json", json.getBytes(StandardCharsets.UTF_8), who, Map.of("Accept", "application/json"));
    }

    private String form() {
        assumeTrue(target().signingForm() != null, "the host names no form that asks for a passkey signature");
        return target().signingForm();
    }

    private String challengeBody() {
        return "{\"form\":\"" + form() + "\",\"context\":\"submit\"}";
    }

    @Test
    @Order(1601)
    default void aPageReadsTheSigningBlockAndAVisitorHasNoPasskeys() {
        Reply page = http().send("GET", path("/passkeys?form=" + form()), null, null, HostTarget.Who.VISITOR, Map.of("Accept", "application/json"));
        assertThat(page.status()).as(page.toString()).isEqualTo(200);
        JsonNode body = page.json();
        assertThat(body.path("passkeys").isArray()).as(body.toString()).isTrue();
        assertThat(body.path("passkeys")).isEmpty();
        JsonNode signing = body.path("signing");
        assertThat(signing.path("mode").asString()).as(signing.toString()).isIn("required", "optional");
        assertThat(signing.path("ready").isBoolean()).as(signing.toString()).isTrue();
        assertThat(signing.path("signIn").isBoolean()).as(signing.toString()).isTrue();
    }

    @Test
    @Order(1602)
    default void aVisitorMayAskForAChallengeOnlyWhereSigningNeedsNoSignIn() {
        JsonNode signing = http().send("GET", path("/passkeys?form=" + form()), null, null, HostTarget.Who.VISITOR, Map.of()).json().path("signing");
        Reply anonymous = post("/challenge", challengeBody(), HostTarget.Who.VISITOR);
        if (signing.path("signIn").asBoolean()) {
            assertThat(anonymous.status()).as(anonymous.toString()).isEqualTo(403);
            assertThat(anonymous.code()).isEqualTo("signing.sign_in");
        } else {
            assertThat(anonymous.status()).as(anonymous.toString()).isEqualTo(200);
        }
        Reply wrongType = http().send("POST", path("/challenge"), "text/plain", challengeBody().getBytes(StandardCharsets.UTF_8),
            HostTarget.Who.PERSON, Map.of());
        assertThat(wrongType.status()).as(wrongType.toString()).isEqualTo(415);
    }

    @Test
    @Order(1603)
    default void aSignedInPersonGetsAChallengeAndTheRegisterRefusalsComeInOrder() {
        Reply challenge = post("/challenge", challengeBody(), HostTarget.Who.PERSON);
        assertThat(challenge.status()).as(challenge.toString()).isEqualTo(200);
        JsonNode options = challenge.json();
        for (String member : new String[] {"challenge", "token", "expires"}) {
            assertThat(options.path(member).asString()).as(member + " in " + options).isNotBlank();
        }
        assertThat(options.path("rp").path("id").asString()).isNotBlank();
        assertThat(options.path("user").path("id").asString()).isNotBlank();
        assertThat(options.path("pubKeyCredParams")).isNotEmpty();

        Reply unreadable = post("/register", "{\"form\":\"" + form() + "\",\"context\":\"submit\",\"token\":\"x\"}", HostTarget.Who.PERSON);
        assertThat(unreadable.status()).as(unreadable.toString()).isEqualTo(400);
        assertThat(unreadable.code()).isEqualTo("passkey.bad_request");

        ObjectNode posted = TckFixtures.JSON.createObjectNode();
        posted.put("form", form());
        posted.put("context", "submit");
        ObjectNode credential = posted.putObject("credential");
        credential.put("id", "AAAAAAAAAAAAAAAAAAAAAA");
        credential.putObject("response").put("clientDataJSON", "e30").put("attestationObject", "oA");
        posted.put("token", "never-issued");
        Reply notIssued = post("/register", posted.toString(), HostTarget.Who.PERSON);
        assertThat(notIssued.status()).as(notIssued.toString()).isEqualTo(400);
        assertThat(notIssued.code()).isEqualTo("passkey.challenge");

        posted.put("token", options.path("token").asString());
        Reply forged = post("/register", posted.toString(), HostTarget.Who.PERSON);
        assertThat(forged.status()).as(forged.toString()).isEqualTo(422);
        assertThat(forged.code()).isEqualTo("passkey.invalid");
        Reply again = post("/register", posted.toString(), HostTarget.Who.PERSON);
        assertThat(again.status()).as("the token is single-use: " + again).isEqualTo(400);
        assertThat(again.code()).isEqualTo("passkey.challenge");
    }

    @Test
    @Order(1604)
    default void aPersonsListIsTheirsAndAnotherPersonsPasskeyIsNotFound() {
        Reply mine = http().send("GET", path("/passkeys"), null, null, HostTarget.Who.PERSON, Map.of("Accept", "application/json"));
        assertThat(mine.status()).as(mine.toString()).isEqualTo(200);
        assertThat(mine.json().path("passkeys").isArray()).isTrue();
        Reply notTheirs = http().send("DELETE", path("/passkeys/AAAAAAAAAAAAAAAAAAAAAA"), null, null, HostTarget.Who.OTHER_PERSON,
            Map.of("Accept", "application/json"));
        assertThat(notTheirs.status()).as(notTheirs.toString()).isEqualTo(404);
    }
}
