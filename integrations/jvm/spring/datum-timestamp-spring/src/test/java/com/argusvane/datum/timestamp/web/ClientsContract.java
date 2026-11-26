package com.argusvane.datum.timestamp.web;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

/** The server for clients only (access=clients) with two configured clients. */
public abstract class ClientsContract extends TsaContract {

    private static final String CHALLENGE = "Bearer realm=\"timestamp server\", Basic realm=\"timestamp server\"";

    @Test
    void noKeyIs401WithTheChallenge() {
        Reply reply = stamp();

        assertThat(reply.status()).isEqualTo(401);
        assertThat(reply.headers().getFirst("WWW-Authenticate")).isEqualTo(CHALLENGE);
        assertThat(reply.type()).startsWith("text/plain");
        assertThat(reply.headers().getFirst("Cache-Control")).isEqualTo("no-store");
        assertThat(reply.text()).startsWith("This timestamp server needs a client key");
    }

    @Test
    void aBearerKeyWorks() {
        assertThat(stamp("Authorization", "Bearer " + KEY_ONE).status()).isEqualTo(200);
        assertThat(stamp("Authorization", "bearer " + KEY_TWO).status()).as("the scheme is case-insensitive").isEqualTo(200);
    }

    @Test
    void theBasicPasswordWorksWithAnyUserName() {
        assertThat(stamp("Authorization", basic(KEY_ONE)).status()).isEqualTo(200);
    }

    @Test
    void aBasicHeaderWithoutAPasswordIs401() {
        String empty = "Basic " + java.util.Base64.getEncoder().encodeToString("user:".getBytes(java.nio.charset.StandardCharsets.UTF_8));

        assertThat(stamp("Authorization", empty).status()).isEqualTo(401);
    }

    @Test
    void aWrongKeyIs401() {
        assertThat(stamp("Authorization", "Bearer dtsa_wrong").status()).isEqualTo(401);
        assertThat(stamp("Authorization", basic("dtsa_wrong")).status()).isEqualTo(401);
        assertThat(stamp("Authorization", "Token " + KEY_ONE).status()).isEqualTo(401);
    }

    @Test
    void theClientIsTheOneTheKeyBelongsTo() {
        int before = events.issued.size();
        stamp("Authorization", "Bearer " + KEY_TWO);

        assertThat(events.issued.get(before).client()).isEqualTo(HASH_TWO.substring(0, 12));
    }

    @Test
    void theRefusalsThatNeedNoKeyComeFirst() {
        assertThat(send("POST", path(), new byte[] {1}, "Content-Type", "application/json").status()).as("415 before the key").isEqualTo(415);
        assertThat(send("POST", path(), new byte[] {1}, "Content-Type", QUERY, "Cookie", "JSESSIONID=1").status()).as("403 before the key").isEqualTo(403);
    }

    @Test
    void theCertificatesAreOpenToEveryone() {
        assertThat(get(path() + "/certificate").status()).isEqualTo(200);
        assertThat(get(path() + "/certificates").status()).isEqualTo(200);
    }

    @Test
    void aGoodRequestWithAKeyThatIsRefusedStillCarriesAReply() throws Exception {
        Reply reply = post("garbage".getBytes(java.nio.charset.StandardCharsets.US_ASCII), "Authorization", "Bearer " + KEY_ONE);

        assertThat(reply.status()).isEqualTo(400);
        assertThat(parse(reply).getStatus()).isEqualTo(2);
    }
}
