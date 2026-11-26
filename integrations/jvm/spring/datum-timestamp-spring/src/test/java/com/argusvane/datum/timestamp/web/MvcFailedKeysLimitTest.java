package com.argusvane.datum.timestamp.web;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.test.web.servlet.MockMvc;

/** {@code datum.tsa.flood.failed-keys}: three wrong keys per address per hour, then 429 with the hour to wait. */
@SpringBootTest(classes = TsaMvcTestApp.class, properties = {
    "datum.tsa.enabled=true", "datum.tsa.allow-memory-stores=true",
    "datum.tsa.access=clients",
    "datum.tsa.signer.self-signed=true",
    "datum.tsa.flood.failed-keys=3",
    "datum.tsa.clients[0]=c2931b824fd8a71cdfbdb5a24c62eaed4b9d2dde904e70cc4f1a29378bdb9102",
    "spring.main.web-application-type=servlet"})
@AutoConfigureMockMvc
class MvcFailedKeysLimitTest extends TsaContract {

    @Autowired
    MockMvc mvc;

    @Override
    protected Reply send(String method, String path, byte[] body, String... headers) {
        return MvcTransport.send(mvc, method, path, body, headers);
    }

    @Test
    void theFourthWrongKeyIs429WhenTheLimitIsThree() {
        for (int i = 0; i < 3; i++) {
            assertThat(stamp("Authorization", "Bearer dtsa_wrong" + i).status()).as("attempt " + i).isEqualTo(401);
        }
        Reply fourth = stamp("Authorization", "Bearer dtsa_wrong3");
        assertThat(fourth.status()).isEqualTo(429);
        assertThat(fourth.headers().getFirst("Retry-After")).isEqualTo("3600");
        assertThat(stamp("Authorization", "Bearer " + KEY_ONE).status()).as("the right key is not let through either").isEqualTo(429);
    }
}
