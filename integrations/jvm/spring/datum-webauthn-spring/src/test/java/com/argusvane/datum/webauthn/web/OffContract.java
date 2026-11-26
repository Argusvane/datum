package com.argusvane.datum.webauthn.web;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.web.monitoring.DatumHealthContributors;
import com.argusvane.datum.webauthn.RegistrationCeremony;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.ApplicationContext;

/** datum.webauthn.enabled is false: no endpoint, no beans, the paths are the application's. */
public abstract class OffContract {

    @Autowired
    ApplicationContext context;

    protected abstract Reply send(String method, String path, byte[] body, String... headers);

    @Test
    void everyPathIs404AndNoBeanIsMade() {
        byte[] json = "{}".getBytes(StandardCharsets.UTF_8);
        assertThat(send("POST", "/api/webauthn/challenge", json, "Content-Type", "application/json").status()).isEqualTo(404);
        assertThat(send("POST", "/api/webauthn/register", json, "Content-Type", "application/json").status()).isEqualTo(404);
        assertThat(send("GET", "/api/webauthn/passkeys", null).status()).isEqualTo(404);
        assertThat(send("DELETE", "/api/webauthn/passkeys/x", null).status()).isEqualTo(404);
        assertThat(context.getBeanNamesForType(PasskeysApi.class)).isEmpty();
        assertThat(context.getBeanNamesForType(RegistrationCeremony.class)).isEmpty();
        assertThat(context.getBean(DatumHealthContributors.class).evaluate()).doesNotContainKey("datum-webauthn");
        assertThat(send("GET", "/v3/api-docs/datum-webauthn", null).status()).isEqualTo(404);
    }
}
