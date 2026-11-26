package com.argusvane.datum.examples.submissions;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.sandbox.protocol.RuleModule;
import com.argusvane.datum.starter.test.DatumTck;
import com.argusvane.datum.submissions.spi.SandboxRulesProvider;
import com.argusvane.datum.tck.HardeningContract;
import com.argusvane.datum.tck.HostTarget;
import com.argusvane.datum.tck.Reply;
import com.argusvane.datum.tck.TckFixtures;
import java.util.List;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.context.annotation.Bean;
import tools.jackson.databind.node.ObjectNode;

/**
 * The hardening subset over HTTP with the REAL runtime (integrations/jvm/README.md "Libraries and bindings"): this test deployment registers
 * the host test kit's hostile rule module for the fixture form, and the kit's hardening contract posts the four
 * attacks (a loop, memory without bound, a 40 MiB answer, bytes after the answer frame) and then a valid submission.
 * The module is a test's only: never registered by the example itself. The validation memory budget is raised so the
 * 40 MiB answer is stopped by the output cap, not by the module failing to build it; this example also asserts that.
 */
@Tag("real-runtime")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
    // Room for the 40 MiB answer to be built, so the run's output cap is what stops it (the kit's 1803).
    "datum.runtime.validation.memory=512MB"})
class SubmissionsHardeningIT implements HardeningContract {

    /** The kit's hostile module for the kit's fixture form, as an application registers its own rule modules. */
    @TestConfiguration(proxyBeanMethods = false)
    static class HostileRules {

        @Bean
        SandboxRulesProvider datumTckHardeningRules() {
            RuleModule module = new RuleModule("datum-tck-hardening", "1", TckFixtures.hardeningRules());
            return (formKey, definition, submission) -> TckFixtures.FORM.equals(formKey) ? List.of(module) : List.of();
        }
    }

    @LocalServerPort
    int port;

    @Override
    public HostTarget target() {
        return DatumTck.local(port);
    }

    /** With 512 MB the module builds its 40 MiB answer, and the runtime's caps stop it, not the module. */
    @Test
    @Order(1)
    void theFortyMebibyteAnswerMeetsTheCapsNotTheMemoryBudget() {
        ObjectNode values = TckFixtures.validValues();
        values.put("name", TckFixtures.HUGE);
        Reply reply = http().postJson(target().api("/submissions"), TckFixtures.delivered(TckFixtures.envelope(TckFixtures.VERSION, values)));
        // The caps stopped the run, so no verdict was reached: the server's 503, never a 422 about the answers.
        assertThat(reply.status()).as(reply.toString()).isEqualTo(503);
        assertThat(reply.code()).as(reply.toString()).isIn("outcome_too_large", "wasm.execution_error");
    }
}
