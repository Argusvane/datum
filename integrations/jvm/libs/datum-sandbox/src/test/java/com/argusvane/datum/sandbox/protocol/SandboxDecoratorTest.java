package com.argusvane.datum.sandbox.protocol;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * The sandbox seam: {@link SandboxService} stays the protocol, built by the
 * runtime, and any number of {@link SandboxDecorator}s wrap it in order, as Spring Boot composes its task decorators. The
 * gate, the run and the outcome stay the service's whatever the decorators record.
 */
class SandboxDecoratorTest {

    private static final Program PROGRAM = Program.of(Program.Kind.SANDBOX, "/* program */".getBytes(StandardCharsets.UTF_8));

    /** Records each call by name with its own label, then delegates; never answers in the service's place. */
    static final class Counting implements Sandbox {

        final Sandbox delegate;
        final List<String> calls;
        final String label;

        Counting(Sandbox delegate, List<String> calls, String label) {
            this.delegate = delegate;
            this.calls = calls;
            this.label = label;
        }

        @Override
        public Program program() {
            return delegate.program();
        }

        @Override
        public SandboxResult validate(ObjectNode context, List<RuleModule> rules, boolean real) {
            calls.add(label + ":validate");
            return delegate.validate(context, rules, real);
        }

        @Override
        public ObjectNode inspect(String op, ObjectNode definition, String formulaErrors, Map<String, JsonNode> extra, List<RuleModule> rules) {
            calls.add(label + ":inspect:" + op);
            return delegate.inspect(op, definition, formulaErrors, extra, rules);
        }

        @Override
        public ObjectNode check(ObjectNode definition, List<String> types, List<RuleModule> rules) {
            calls.add(label + ":check");
            return delegate.check(definition, types, rules);
        }

        @Override
        public ObjectNode publicCopy(ObjectNode definition) {
            calls.add(label + ":public");
            return delegate.publicCopy(definition);
        }

        @Override
        public Smoke smoke() {
            calls.add(label + ":smoke");
            return delegate.smoke();
        }

        @Override
        public void proveAbi() {
            calls.add(label + ":prove");
            delegate.proveAbi();
        }
    }

    private static ObjectNode context() throws StrictJson.NotJsonException {
        return (ObjectNode) StrictJson.decode("{\"formId\":\"f\",\"form\":{\"id\":\"root\",\"type\":\"form\",\"configuration\":{},"
            + "\"children\":{\"content\":[]}},\"values\":{},\"locale\":\"en\"}");
    }

    private static SandboxService service(FakeRuntime runtime, AbiProbe probe) {
        return new SandboxService(runtime, PROGRAM, new RunScript("/* f */"), ProgramLimits.defaults(), HostOptions.defaults(),
            new RunSlots(1, Duration.ZERO, "validation"), probe, RunLog.slf4j());
    }

    @Test
    void noDecoratorIsTheServiceItself() {
        SandboxService service = service(FakeRuntime.answering("{\"errors\":[]}"), new AbiProbe());
        assertThat(SandboxDecorator.compose(List.of()).decorate(service)).isSameAs(service);
    }

    @Test
    void decoratorsComposeInOrderTheFirstWrapsTheServiceTheLastSeesEachCallFirst() throws Exception {
        FakeRuntime runtime = FakeRuntime.answering("{\"errors\":[]}");
        List<String> calls = new ArrayList<>();
        AbiProbe probe = new AbiProbe();
        SandboxService service = service(runtime, probe);
        Sandbox sandbox = SandboxDecorator.compose(List.<SandboxDecorator>of(
            inner -> new Counting(inner, calls, "tracing"),
            inner -> new Counting(inner, calls, "audit"))).decorate(service);

        assertThat(sandbox).isInstanceOfSatisfying(Counting.class, outer -> {
            assertThat(outer.label).isEqualTo("audit");
            assertThat(outer.delegate).isInstanceOfSatisfying(Counting.class, inner -> {
                assertThat(inner.label).isEqualTo("tracing");
                assertThat(inner.delegate).as("the protocol is the service's").isSameAs(service);
            });
        });

        sandbox.proveAbi();
        assertThat(probe.sandboxProved(PROGRAM)).as("the runtime's gate is the one proved").isTrue();
        assertThat(sandbox.validate(context(), List.of(), false).outcome().path("errors").isArray()).isTrue();
        // The probe ran once (by the proof), then the validation: the decorators changed neither.
        assertThat(runtime.calls).hasSize(2);
        assertThat(FakeRuntime.isProbe(runtime.calls.get(0))).isTrue();
        assertThat(calls).containsExactly("audit:prove", "tracing:prove", "audit:validate", "tracing:validate");
    }

    @Test
    void aDecoratorThatAnswersNothingIsRefused() {
        SandboxService service = service(FakeRuntime.answering("{\"errors\":[]}"), new AbiProbe());
        assertThatThrownBy(() -> SandboxDecorator.compose(List.of(inner -> null)).decorate(service))
            .isInstanceOf(NullPointerException.class).hasMessageContaining("answered null");
    }
}
