package com.argusvane.datum.webauthn.web;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

/** datum.webauthn.path=/passkeys-v2/: every expectation of the configured site holds at the new path, and the old one is not mapped. */
public abstract class CustomPathContract extends PasskeysContract {

    @Override
    String base() {
        return "/passkeys-v2";
    }

    @Test
    void theDefaultPathIsNotMapped() {
        assertThat(send("POST", BASE + "/challenge", "{}".getBytes(), "Content-Type", "application/json").status()).isEqualTo(404);
        assertThat(send("GET", BASE + "/passkeys", null).status()).isEqualTo(404);
    }
}
