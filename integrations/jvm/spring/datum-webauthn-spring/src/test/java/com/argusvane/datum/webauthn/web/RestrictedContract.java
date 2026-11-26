package com.argusvane.datum.webauthn.web;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.webauthn.WebAuthnTestKit.Authenticator;
import org.junit.jupiter.api.Test;

/** datum.webauthn.anonymous=false and register-at-submit=false. */
public abstract class RestrictedContract extends PasskeysSupport {

    @Test
    void aVisitorMayNotMakeAPasskeyWhileVisitorsPasskeysAreOff() {
        Reply reply = post("/challenge", body("petition", "submit"), null);

        assertThat(reply.status()).isEqualTo(403);
        assertThat(reply.code()).isEqualTo("signing.sign_in");
        assertThat(reply.message()).isEqualTo("Sign in to make a passkey: only people who are signed in can sign on this site.");
        assertThat(post("/register", body("petition", "submit"), null).code()).as("the same for a registration").isEqualTo("signing.sign_in");
    }

    @Test
    void aSiteThatMakesPasskeysAheadOfTimeRefusesThemAtTheForm() {
        Reply submit = post("/challenge", body("petition", "submit"), "ada");
        assertThat(submit.status()).isEqualTo(403);
        assertThat(submit.code()).isEqualTo("signing.register_off");
        assertThat(post("/challenge", body("petition", "amend"), "ada").code()).isEqualTo("signing.register_off");
    }

    @Test
    void theTestContextStillMakesOneSoTestingWorks() {
        Authenticator authenticator = new Authenticator();

        Reply registered = registerWith(authenticator, "petition", "test", "tester", null);

        assertThat(registered.status()).as(registered.text()).isEqualTo(201);
    }

    @Test
    void aPasskeyAheadOfTimeStillWorksForASignedInPerson() {
        Authenticator authenticator = new Authenticator();
        Reply challenge = post("/challenge", body(null, null), "ada");
        var posted = body(null, "account");
        posted.put("token", challenge.json().get("token").asString());
        posted.set("credential", authenticator.credentialFor(challenge.json()));

        assertThat(post("/register", posted, "ada").status()).isEqualTo(201);
    }

    @Test
    void thePageIsToldAVisitorMustSignInAndWhetherItMayRegister() {
        var signing = get("/passkeys?form=petition", null).json().get("signing");

        assertThat(signing.get("signIn").asBoolean()).isTrue();
        assertThat(signing.get("register").asBoolean()).isFalse();
        assertThat(get("/passkeys?form=petition", "ada").json().get("signing").get("signIn").asBoolean()).isFalse();
    }
}
