package com.argusvane.datum.timestamp.web;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

/** Ten wrong keys per address per hour, then 429 for that address, whatever key it sends next. */
public abstract class FailedKeysContract extends TsaContract {

    @Test
    void theEleventhWrongKeyIs429WithAnHourToWait() {
        for (int i = 0; i < 10; i++) {
            assertThat(stamp("Authorization", "Bearer dtsa_wrong" + i).status()).as("attempt " + i).isEqualTo(401);
        }
        Reply eleventh = stamp("Authorization", "Bearer dtsa_wrong10");

        assertThat(eleventh.status()).isEqualTo(429);
        assertThat(eleventh.headers().getFirst("Retry-After")).isEqualTo("3600");
        assertThat(eleventh.text()).isEqualTo("Too many requests with a wrong key from this address. Try again later.\n");
        assertThat(stamp("Authorization", "Bearer " + KEY_ONE).status()).as("the right key is not let through either").isEqualTo(429);
        assertThat(stamp().status()).as("nor a request with no key").isEqualTo(429);
    }
}
