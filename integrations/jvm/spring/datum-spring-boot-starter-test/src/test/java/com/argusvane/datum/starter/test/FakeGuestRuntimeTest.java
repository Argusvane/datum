package com.argusvane.datum.starter.test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.sandbox.runtime.DatumSandbox;
import com.argusvane.datum.sandbox.protocol.Program;
import com.argusvane.datum.sandbox.protocol.ProgramRunner;
import java.nio.charset.StandardCharsets;
import java.util.List;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.node.ObjectNode;

class FakeGuestRuntimeTest {

    @Test
    void theKernelsPublicOpRemovesServerSecretRules() {
        FakeGuestRuntime runtime = new FakeGuestRuntime();
        ObjectNode secret = DatumTestForms.secret();
        assertThat(secret.has("rules")).isTrue();
        ObjectNode copy = (ObjectNode) FakeGuestRuntime.stripSecretRules(secret.deepCopy());
        assertThat(copy.has("rules")).as("the only rule is server-secret").isFalse();
        assertThat(copy.path("id").asString()).isEqualTo("secret");
        assertThat(runtime.requests()).isEmpty();
    }

    @Test
    void anOpNobodyAnswersIsAnAssertionError() {
        FakeGuestRuntime runtime = new FakeGuestRuntime();
        String nonce = "0123456789abcdef0123456789abcdef";
        byte[] stdin = (nonce + "\n{\"op\":\"surprise\"}").getBytes(StandardCharsets.UTF_8);
        Program sandbox = Program.of(Program.Kind.SANDBOX, new byte[0]);
        assertThatThrownBy(() -> runtime.run(ProgramRunner.guestRun(sandbox, "", List.of(), stdin, new com.argusvane.datum.sandbox.wasi.Budget(5, 64L << 20, 1 << 20, 1 << 20))))
            .isInstanceOf(AssertionError.class).hasMessageContaining("surprise");
    }

    @Test
    void validationRunsAreAnsweredByTheScriptedOutcome() {
        FakeGuestRuntime runtime = new FakeGuestRuntime().outcome(context -> {
            ObjectNode refused = DatumTestForms.json("{\"errors\":[{\"componentId\":\"name\",\"code\":\"required\"}]}");
            return refused;
        });
        assertThat(runtime.nativeProvider()).isEqualTo("jffi");
        assertThat(runtime.nativeProvider("panama").nativeProvider()).isEqualTo("panama");
        assertThat(runtime.engineInfo().mode()).as("what the lifecycle reports").isEqualTo("panama");
        assertThat(ProgramRunner.canRunPdf(runtime.engineInfo())).as("the lifecycle runs the PDF program on it").isTrue();
        assertThat(ProgramRunner.canRunPdf(runtime.nativeProvider("bytecode").engineInfo())).isFalse();
        assertThat(runtime.reset().engineInfo().mode()).isEqualTo("jffi");
        assertThat(runtime.contexts()).isEmpty();
        assertThat(runtime.reset().count("public")).isZero();
    }

    @Test
    void theAcceptingAnswerCarriesTheDigestOfTheDocument() {
        ObjectNode context = DatumTestForms.json("{\"values\":{\"name\":\"Ada\"},\"document\":{\"a\":1}}");
        ObjectNode outcome = FakeGuestRuntime.accepting(context);
        assertThat(outcome.path("errors")).isEmpty();
        assertThat(outcome.path("values").path("name").asString()).isEqualTo("Ada");
        assertThat(outcome.path("canonical").asString()).isEqualTo("{\"a\":1}");
        assertThat(outcome.path("digest").asString()).hasSize(64);
    }
}
