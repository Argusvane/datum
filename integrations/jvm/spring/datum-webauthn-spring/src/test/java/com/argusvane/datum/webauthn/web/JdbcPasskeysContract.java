package com.argusvane.datum.webauthn.web;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.webauthn.ChallengeClaims;
import com.argusvane.datum.webauthn.PasskeyRepository;
import com.argusvane.datum.webauthn.PasskeyUseStore;
import com.argusvane.datum.webauthn.WebAuthnTestKit.Authenticator;
import com.argusvane.datum.webauthn.spring.JdbcChallengeClaims;
import com.argusvane.datum.webauthn.spring.JdbcPasskeyRepository;
import com.argusvane.datum.webauthn.spring.JdbcPasskeyUseStore;
import org.junit.jupiter.api.Test;

/** The whole contract over the SQL stores, and what only they do. */
public abstract class JdbcPasskeysContract extends PasskeysContract {

    @Override
    boolean storesCheckCounter() {
        return true;
    }

    @Override
    String storeKind() {
        return "jdbc";
    }

    @Test
    void theStoresAreTheSqlOnesWithNothingAcknowledged() {
        assertThat(context.getBean(PasskeyRepository.class)).isInstanceOf(JdbcPasskeyRepository.class);
        assertThat(context.getBean(PasskeyUseStore.class)).isInstanceOf(JdbcPasskeyUseStore.class);
        assertThat(context.getBean(ChallengeClaims.class)).isInstanceOf(JdbcChallengeClaims.class);
        assertThat(context.getEnvironment().getProperty("datum.webauthn.allow-memory-stores", "false")).isEqualTo("false");
    }

    @Test
    void aTestMovesWhenThePasskeyWasLastUsed() {
        Authenticator authenticator = new Authenticator();
        String id = registered(authenticator, "petition", "shafi");
        var challenge = post("/passkeys/" + id + "/check-challenge", new byte[0], "shafi").json();
        var posted = JSON.createObjectNode();
        posted.put("token", challenge.get("token").asString());
        posted.set("assertion", authenticator.assertionFor(challenge, java.util.Map.of("counter", 7L)));
        assertThat(post("/passkeys/" + id + "/check", posted, "shafi").status()).isEqualTo(200);

        var stored = context.getBean(PasskeyRepository.class).find(id).orElseThrow();
        assertThat(stored.lastUsed()).isNotNull();
        assertThat(stored.signCount()).isEqualTo(7);
        assertThat(get("/passkeys", "shafi").json().get("passkeys").get(0).get("lastUsed").asString()).isNotEmpty();
    }
}
