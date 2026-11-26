package com.argusvane.datum.examples.submissions;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.starter.test.DatumTck;
import com.argusvane.datum.tck.FloodContract;
import com.argusvane.datum.tck.FormsContract;
import com.argusvane.datum.tck.HostTarget;
import com.argusvane.datum.tck.Reply;
import com.argusvane.datum.tck.SubmissionsContract;
import com.argusvane.datum.tck.SubmissionsDryRunContract;
import com.argusvane.datum.tck.TckFixtures;
import org.junit.jupiter.api.MethodOrderer;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestMethodOrder;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import tools.jackson.databind.JsonNode;

/**
 * Story one end to end with the REAL runtime: the application boots with datum-sandbox-endive (the starter brings
 * it), proves both programs, and answers the security suite's golden control documents (CTL-01 valid, CTL-02 to
 * CTL-04 invalid) over HTTP, as the kernel decides them. The wire contract is the host test kit's (the submissions,
 * dry-run, forms and flood contracts), the same classes every JVM host binding runs; what is this
 * example's own (its handler's references, the actuator) is tested here.
 */
@Tag("real-runtime")
// The flood cases' settings: a per-form limit FLD-01 reaches within 120 posts, and an address limit above the rest of the
// run (about 60 counted requests) that FLD-02 reaches within 400 bodies that do not parse.
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
    "datum.web.api.endpoints.test=true",
    "datum.web.throttle.limit=30",
    "datum.web.throttle.address-limit=200"})
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class SubmissionsExampleIT implements SubmissionsContract, SubmissionsDryRunContract, FormsContract, FloodContract {

    @LocalServerPort
    int port;

    @Override
    public HostTarget target() {
        return DatumTck.local(port);
    }

    @Test
    @Order(1)
    void theGoldenValidDocumentIsAnsweredWithTheHandlersReference() {
        Reply reply = http().postJson(target().api("/submissions"), TckFixtures.delivered(TckFixtures.envelope("CTL-01")));
        assertThat(reply.status()).as(reply.toString()).isEqualTo(200);
        JsonNode body = reply.json();
        assertThat(body.path("status").asString()).isEqualTo("accepted");
        // The example's handler numbers what it stores; this is the first submission of the run.
        assertThat(body.path("reference").asString()).isEqualTo("SUB-0001");
        assertThat(body.path("digest").asString()).hasSize(64);
    }

    @Test
    @Order(8)
    void healthSaysWhichStoresAreInMemory() {
        Reply health = http().get("/actuator/health");
        assertThat(health.status()).as(health.toString()).isEqualTo(200);
        JsonNode info = http().get("/actuator/info").json();
        assertThat(info.path("datum").path("idempotency").asString()).isEqualTo("memory");
    }
}
