package com.argusvane.datum.examples.submissions;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.sandbox.protocol.RuleModule;
import com.argusvane.datum.sandbox.protocol.RunLog;
import com.argusvane.datum.sandbox.protocol.Sandbox;
import com.argusvane.datum.sandbox.protocol.SandboxDecorator;
import com.argusvane.datum.starter.test.DatumTck;
import com.argusvane.datum.submissions.spi.SandboxRulesProvider;
import com.argusvane.datum.tck.HostContract;
import com.argusvane.datum.tck.HostTarget;
import com.argusvane.datum.tck.Reply;
import com.argusvane.datum.tck.TckFixtures;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.context.annotation.Bean;

/**
 * The submissions binding's security seams with the REAL runtime: the application's {@link RunLog} bean
 * receives a line the guest wrote with {@code context.log}, and {@link SandboxDecorator} beans (two of them, in
 * their {@code @Order}, both seeing every run) count the sandbox runs of both the receiver ({@code POST /api/submissions})
 * and the definition service (the public copy behind {@code GET /api/forms/{key}/definition}: the kit's fixture form has a
 * server-secret rule, so only the kernel can make it), besides the runtime's own ABI proof and warm-up runs. The rule
 * module that logs is this test's only.
 */
@Tag("real-runtime")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = "datum.runtime.warm-up-runs=1")
class SandboxSeamsIT implements HostContract {

    private static final List<String> LOGGED = new CopyOnWriteArrayList<>();
    private static final Map<String, AtomicInteger> RUNS = new ConcurrentHashMap<>();
    private static final Map<String, AtomicInteger> AUDITED = new ConcurrentHashMap<>();

    @TestConfiguration(proxyBeanMethods = false)
    static class Seams {

        /** A guest that writes one warn entry with data for the fixture form, and judges nothing. */
        @Bean
        SandboxRulesProvider loggingRules() {
            RuleModule module = new RuleModule("datum-it-log", "1",
                "({ validators: [ function (context) { context.log.warn(\"seam check\", { field: \"name\" }); return { errors: [] }; } ] })");
            return (formKey, definition, submission) -> TckFixtures.FORM.equals(formKey) ? List.of(module) : List.of();
        }

        /** The application's run log: one line per entry, as it chooses to write them. */
        @Bean
        RunLog capturingRunLog() {
            return (form, level, message, data) -> LOGGED.add(form + "|" + level + "|" + message + "|" + (data == null ? "" : data.toString()));
        }

        /** A decorator in front of every sandbox run: counts each call by name, then delegates. */
        @Bean
        @org.springframework.core.annotation.Order(10)
        SandboxDecorator countingSandboxDecorator() {
            return service -> counting(service, RUNS);
        }

        /** A second party's decorator (an audit library's): it wraps the first, and does not replace it. */
        @Bean
        @org.springframework.core.annotation.Order(20)
        SandboxDecorator auditingSandboxDecorator() {
            return service -> counting(service, AUDITED);
        }

        static Sandbox counting(Sandbox service, Map<String, AtomicInteger> counts) {
            return (Sandbox) Proxy.newProxyInstance(Sandbox.class.getClassLoader(), new Class<?>[] {Sandbox.class}, (proxy, method, args) -> {
                counts.computeIfAbsent(method.getName(), name -> new AtomicInteger()).incrementAndGet();
                try {
                    return method.invoke(service, args);
                } catch (InvocationTargetException e) {
                    throw e.getCause();
                }
            });
        }
    }

    @LocalServerPort
    int port;

    @Override
    public HostTarget target() {
        return DatumTck.local(port);
    }

    private static int runs(String method) {
        AtomicInteger counted = RUNS.get(method);
        return counted == null ? 0 : counted.get();
    }

    @Test
    void theRunLogGetsTheGuestsLineAndOneDecoratorCountsTheReceiverAndTheDefinitionService() {
        assertThat(runs("proveAbi")).as("the runtime's ABI proof went through the decorator").isEqualTo(1);
        assertThat(runs("smoke")).as("and its warm-up run").isEqualTo(1);

        Reply accepted = http().postJson(target().api("/submissions"), TckFixtures.delivered(TckFixtures.envelope("CTL-01")));
        assertThat(accepted.status()).as(accepted.toString()).isEqualTo(200);
        assertThat(runs("validate")).as("the receiver's run").isEqualTo(1);
        // The kernel logs its own warnings too (the fixture form's risky pattern), so the rule module's line is one of them.
        assertThat(LOGGED).as("the guest's context.log line reached the application's RunLog")
            .contains(TckFixtures.FORM + "|warn|seam check|{\"field\":\"name\"}");

        Reply definition = http().get(target().api("/forms/" + TckFixtures.FORM + "/definition"));
        assertThat(definition.status()).as(definition.toString()).isEqualTo(200);
        assertThat(definition.text()).doesNotContain(TckFixtures.SECRET_MARKER);
        assertThat(runs("publicCopy")).as("the definition service's run").isEqualTo(1);
        assertThat(AUDITED.get("validate")).as("the second decorator saw the receiver's run too").hasValue(1);
        assertThat(AUDITED.get("publicCopy")).hasValue(1);
        assertThat(AUDITED.get("proveAbi")).hasValue(1);
    }
}
