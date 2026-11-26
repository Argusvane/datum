package com.argusvane.datum.webauthn.web;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.web.monitoring.DatumHealthContributors;
import org.junit.jupiter.api.Test;

/** No datum.webauthn.rp-id or origins: passkeys are not set up (503 signing.not_set_up; nothing is taken from the Host header). */
public abstract class NotSetUpContract extends PasskeysSupport {

    @Test
    void everyEndpointThatNeedsPasskeysAnswers503() {
        Reply challenge = post("/challenge", body("petition", "submit"), null);
        assertThat(challenge.status()).isEqualTo(503);
        assertThat(challenge.code()).isEqualTo("signing.not_set_up");
        assertThat(challenge.message()).isEqualTo("Passkeys are not set up on this site.");
        assertThat(post("/challenge", body(null, null), "ada").code()).as("ahead of time too").isEqualTo("signing.not_set_up");
        assertThat(post("/register", body("petition", "submit"), null).code()).isEqualTo("signing.not_set_up");
    }

    @Test
    void theFormSettingsStillAnswerSoThePageKnowsTheRealModeAndThePolicy() {
        // The page must follow the form's own mode and unavailable policy: a 503 here would
        // make it assume "required" and block a form the server accepts unsigned.
        Reply reply = get("/passkeys?form=petition", "ada");

        assertThat(reply.status()).isEqualTo(200);
        assertThat(reply.json().get("signing").get("ready").asBoolean()).isFalse();
        assertThat(reply.json().get("signing").get("mode").asString()).isEqualTo("required");
        assertThat(reply.json().get("passkeys").size()).isZero();
        assertThat(get("/passkeys?form=survey", "ada").code()).as("an unsigned form is still not found").isEqualTo("signing.off");
    }

    @Test
    void aFormThatDoesNotSignIsStillNotFoundFirst() {
        assertThat(post("/challenge", body("survey", "submit"), null).code()).isEqualTo("signing.off");
        assertThat(post("/challenge", body("private", "submit"), null).code()).isEqualTo("signing.not_set_up");
    }

    @Test
    void theListWithoutAFormNeedsNoSetUp() {
        assertThat(get("/passkeys", "ada").status()).isEqualTo(200);
    }

    @Test
    void healthIsDownAndSaysWhy() {
        DatumHealthContributors.Status status = context.getBean(DatumHealthContributors.class).evaluate().get("datum-webauthn");

        assertThat(status.up()).isFalse();
        assertThat(status.details().get("reason").toString()).contains("datum.webauthn.rp-id");
    }
}
