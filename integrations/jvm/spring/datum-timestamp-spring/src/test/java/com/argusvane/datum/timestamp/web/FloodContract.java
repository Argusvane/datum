package com.argusvane.datum.timestamp.web;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

/** Open access with two tokens per window (30 minutes): per client for a client's requests, per address for open ones. */
public abstract class FloodContract extends TsaContract {

    @Test
    void openRequestsAreLimitedPerAddress() {
        assertThat(stamp().status()).isEqualTo(200);
        assertThat(stamp().status()).isEqualTo(200);
        Reply third = stamp();

        assertThat(third.status()).isEqualTo(429);
        assertThat(third.headers().getFirst("Retry-After")).isEqualTo("1800");
        assertThat(third.type()).startsWith("text/plain");
        assertThat(third.headers().getFirst("Cache-Control")).isEqualTo("no-store");
        assertThat(third.text()).isEqualTo("Too many timestamp requests. Try again later.\n");
    }

    @Test
    void aClientsRequestsAreLimitedPerClientAndAnotherClientIsNot() {
        assertThat(stamp("Authorization", "Bearer " + KEY_ONE).status()).isEqualTo(200);
        assertThat(stamp("Authorization", "Bearer " + KEY_ONE).status()).isEqualTo(200);
        Reply third = stamp("Authorization", "Bearer " + KEY_ONE);

        assertThat(third.status()).isEqualTo(429);
        assertThat(third.headers().getFirst("Retry-After")).isEqualTo("1800");
        assertThat(stamp("Authorization", "Bearer " + KEY_TWO).status()).isEqualTo(200);
    }

    @Test
    void aRefusedRequestStillCountsAgainstTheLimitOnlyAfterItPassesTheEarlierChecks() {
        // 415 comes before the flood check: it spends nothing.
        for (int i = 0; i < 5; i++) {
            assertThat(send("POST", path(), new byte[] {1}, "Content-Type", "text/plain").status()).isEqualTo(415);
        }
    }
}
