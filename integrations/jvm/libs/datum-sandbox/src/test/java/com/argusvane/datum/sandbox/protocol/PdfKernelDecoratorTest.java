package com.argusvane.datum.sandbox.protocol;

import com.argusvane.datum.core.contracts.PdfCapabilitiesResponse;
import com.argusvane.datum.sandbox.wasi.RunOutput;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

/**
 * The PDF program's decorator seam (the PDF side of {@link SandboxDecorator}): {@link PdfProgram} stays the
 * protocol, and the decorators wrap it in order, so the gate, the run and the refusal are the program's whatever they record.
 */
class PdfKernelDecoratorTest {

    private static final Program PDF = Program.of(Program.Kind.PDF, "/* pdf */".getBytes(StandardCharsets.UTF_8));

    /** Records each call by name, then delegates. */
    static final class Counting implements PdfKernel {

        final PdfKernel delegate;
        final List<String> calls;
        final String label;

        Counting(PdfKernel delegate, List<String> calls, String label) {
            this.delegate = delegate;
            this.calls = calls;
            this.label = label;
        }

        @Override
        public Program program() {
            return delegate.program();
        }

        @Override
        public PdfCapabilitiesResponse capabilities() {
            calls.add(label + ":capabilities");
            return delegate.capabilities();
        }

        @Override
        public ObjectNode call(ObjectNode request) {
            calls.add(label + ":call:" + request.path("op").asString(""));
            return delegate.call(request);
        }
    }

    private static FakeRuntime guest(String answer) {
        return new FakeRuntime(call -> {
            String op = call.input().path("op").asString("");
            String text = "capabilities".equals(op)
                ? "{\"ok\":true,\"op\":\"capabilities\",\"abi\":\"" + PdfAbi.MIN + "\",\"kernelVersion\":\"0.1.0\"}"
                : answer;
            return RunOutput.exited(0, (text + "\n").getBytes(StandardCharsets.UTF_8), null);
        });
    }

    @Test
    void noDecoratorIsTheProgramItself() {
        PdfProgram program = new PdfProgram(guest("{}"), PDF, ProgramLimits.defaults(), new AbiProbe());
        assertThat(PdfKernelDecorator.compose(List.of()).decorate(program)).isSameAs(program);
    }

    @Test
    void decoratorsComposeInOrderAndTheProtocolStaysTheProgramsOnTheGivenParts() {
        List<String> calls = new ArrayList<>();
        FakeRuntime runtime = guest("{\"ok\":false,\"error\":{\"code\":\"layout.notFound\",\"message\":\"no\"}}");
        PdfProgram program = new PdfProgram(runtime, PDF, ProgramLimits.defaults(), new AbiProbe());
        PdfKernel kernel = PdfKernelDecorator.compose(List.<PdfKernelDecorator>of(
            inner -> new Counting(inner, calls, "first"), inner -> new Counting(inner, calls, "second"))).decorate(program);

        ObjectNode request = JsonNodeFactory.instance.objectNode().put("abi", PdfAbi.MIN).put("op", "document");
        assertThatThrownBy(() -> kernel.call(request))
            .as("the program's refusal reaches the caller through the decorators")
            .isInstanceOfSatisfying(SandboxException.class, e -> assertThat(e.reason()).isEqualTo(SandboxException.Reason.REFUSED));
        assertThat(calls).containsExactly("second:call:document", "first:call:document");
        assertThat(runtime.calls).as("the gate ran on the runtime the program was built over, then the call").hasSize(2);
    }

    @Test
    void aDecoratorThatAnswersNullIsRefused() {
        PdfProgram program = new PdfProgram(guest("{}"), PDF, ProgramLimits.defaults(), new AbiProbe());
        assertThatThrownBy(() -> PdfKernelDecorator.compose(List.of(inner -> null)).decorate(program))
            .isInstanceOf(NullPointerException.class).hasMessageContaining("answered null");
    }
}
