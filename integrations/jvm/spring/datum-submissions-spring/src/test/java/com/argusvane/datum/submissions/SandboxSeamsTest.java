package com.argusvane.datum.submissions;

import com.argusvane.datum.sandbox.runtime.TestRuntime;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.core.ProgramUnavailableException;
import com.argusvane.datum.sandbox.wasi.EngineInfo;
import com.argusvane.datum.sandbox.protocol.AbiProbe;
import com.argusvane.datum.sandbox.wasi.Budget;
import com.argusvane.datum.sandbox.protocol.Frame;
import com.argusvane.datum.sandbox.protocol.Program;
import com.argusvane.datum.sandbox.wasi.GuestRuntime;
import com.argusvane.datum.sandbox.protocol.RunLog;
import com.argusvane.datum.sandbox.wasi.RunOutput;
import com.argusvane.datum.sandbox.protocol.Sandbox;
import com.argusvane.datum.sandbox.protocol.SandboxDecorator;
import com.argusvane.datum.sandbox.protocol.SandboxService;
import com.argusvane.datum.sandbox.protocol.StrictJson;
import com.argusvane.datum.forms.DefinitionService;
import com.argusvane.datum.forms.spring.DatumFormsAutoConfiguration;
import com.argusvane.datum.springweb.autoconfigure.DatumWebAutoConfiguration;
import com.argusvane.datum.submissions.receiver.SubmissionReceiver;
import com.argusvane.datum.sandbox.runtime.DatumSandbox;
import com.argusvane.datum.submissions.spi.SubmissionRequest;
import com.argusvane.datum.sandbox.spring.DatumSandboxAutoConfiguration;
import com.argusvane.datum.submissions.spring.DatumSubmissionsAutoConfiguration;
import com.argusvane.datum.sandbox.wasi.GuestRun;
import com.argusvane.datum.sandbox.protocol.ProgramRunner;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.config.BeanPostProcessor;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * The run log is the application's {@code RunLog} bean, and the receiver, the definition service
 * and the runtime's own proof runs share one sandbox, so a decorator ({@code SandboxDecorator} beans, any
 * number in their order, or a {@code BeanPostProcessor} around the {@code Sandbox} bean) counts the runs of both the receiver
 * and the definition service. Also: an application's own {@code DatumEventPublisher} is used as given, and with an
 * {@code ObservationRegistry} each submission and its sandbox run are observations, the run inside the submission.
 */
class SandboxSeamsTest {

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(DatumWebAutoConfiguration.class, DatumFormsAutoConfiguration.class,
            DatumSandboxAutoConfiguration.class, DatumSubmissionsAutoConfiguration.class))
        .withPropertyValues("datum.forms.locations=classpath:/datum-test-forms/*.json", "datum.runtime.warm-up-runs=1");

    /** A definition with a server-secret rule, whose public copy only the kernel can make. */
    private static final String SECRET = "{\"id\":\"secret\",\"root\":{\"id\":\"root\",\"type\":\"form\",\"configuration\":{},\"children\":{\"content\":"
        + "[{\"id\":\"name\",\"type\":\"text\",\"configuration\":{\"label\":\"Name\"}}]}},\"rules\":[{\"id\":\"r\",\"scope\":\"server-secret\"}]}";

    /**
     * The test runtime, plus the kernel's {@code public} op: it answers the definition without its rules, so the definition
     * service can ask the sandbox for a public copy.
     */
    static final class KernelRuntime implements GuestRuntime {

        final TestRuntime delegate = new TestRuntime();
        final AtomicInteger publicRuns = new AtomicInteger();

        @Override
        public EngineInfo engineInfo() {
            return delegate.engineInfo();
        }

        @Override
        public RunOutput run(GuestRun run) {
            byte[] stdin = run.stdinBytes();
            String text = new String(stdin, StandardCharsets.UTF_8);
            if (Program.Kind.of(run) == Program.Kind.SANDBOX && text.length() > 33) {
                JsonNode body;
                try {
                    body = StrictJson.decode(text.substring(33));
                } catch (StrictJson.NotJsonException e) {
                    throw new AssertionError(e);
                }
                if ("public".equals(body.path("op").asString(""))) {
                    publicRuns.incrementAndGet();
                    ObjectNode definition = (ObjectNode) body.get("definition").deepCopy();
                    definition.remove("rules");
                    String nonce = text.substring(0, 32);
                    String answer = "{\"ok\":true,\"op\":\"public\",\"definition\":" + StrictJson.encode(definition) + "}";
                    String framed = Frame.marker(nonce, "started") + "\n" + Frame.marker(nonce, "begin") + "\n" + answer + "\n"
                        + Frame.marker(nonce, "end") + "\n";
                    return RunOutput.exited(0, framed.getBytes(StandardCharsets.UTF_8), null);
                }
            }
            return delegate.run(run);
        }
    }

    /** A decorator through the interface: counts each call by method name, then delegates. */
    static Sandbox counting(Sandbox delegate, Map<String, AtomicInteger> counts) {
        return (Sandbox) Proxy.newProxyInstance(Sandbox.class.getClassLoader(), new Class<?>[] {Sandbox.class}, (proxy, method, args) -> {
            counts.computeIfAbsent(method.getName(), name -> new AtomicInteger()).incrementAndGet();
            try {
                return method.invoke(delegate, args);
            } catch (InvocationTargetException e) {
                throw e.getCause();
            }
        });
    }

    private static int count(Map<String, AtomicInteger> counts, String method) {
        AtomicInteger counted = counts.get(method);
        return counted == null ? 0 : counted.get();
    }

    private static byte[] submission() {
        return Fixtures.delivered(Fixtures.envelope("contact", "1", "{\"name\":\"Ada\"}"));
    }

    @Test
    void theDefaultsAreTheProtocolTheSlf4jRunLogAndAFreshGatePerProof() {
        runner.withBean(GuestRuntime.class, KernelRuntime::new).run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context).hasSingleBean(RunLog.class).doesNotHaveBean(SandboxDecorator.class);
            assertThat(context.getBean(Sandbox.class)).as("no decorator and no registry: the protocol itself").isInstanceOf(SandboxService.class);
            assertThat(context.getBean(AbiProbe.class)).as("a prototype: a recheck proves again").isNotSameAs(context.getBean(AbiProbe.class));
        });
    }

    @Test
    void aSandboxDecoratorBeanCountsTheRunsOfTheReceiverAndTheDefinitionService() {
        Map<String, AtomicInteger> counts = new ConcurrentHashMap<>();
        runner.withBean(GuestRuntime.class, KernelRuntime::new)
            .withBean(SandboxDecorator.class, () -> service -> counting(service, counts))
            .run(context -> {
                assertThat(context).hasNotFailed();
                // The runtime's own proof and warm-up went through it.
                assertThat(count(counts, "proveAbi")).isEqualTo(1);
                assertThat(count(counts, "smoke")).isEqualTo(1);

                assertThat(context.getBean(SubmissionReceiver.class).submit(SubmissionRequest.json(), submission()).body()
                    .path("status").stringValue()).isEqualTo("accepted");
                assertThat(count(counts, "validate")).as("the receiver's run").isEqualTo(1);

                ObjectNode copy = context.getBean(DefinitionService.class).publicCopy((ObjectNode) StrictJson.decode(SECRET));
                assertThat(copy.has("rules")).isFalse();
                assertThat(count(counts, "publicCopy")).as("the definition service's run").isEqualTo(1);
                assertThat(context.getBean(KernelRuntime.class).publicRuns).hasValue(1);
            });
    }

    /**
     * The PDF program's runs go through the {@code PdfKernelDecorator} beans as the sandbox's go through the
     * {@code SandboxDecorator} beans, so one observer in both sees every guest run, the PDF program's ABI proof included.
     */
    @Test
    void aPdfKernelDecoratorBeanSeesThePdfProgramsProofAndItsRuns() {
        List<String> calls = java.util.Collections.synchronizedList(new java.util.ArrayList<>());
        runner.withBean(GuestRuntime.class, KernelRuntime::new)
            .withBean(com.argusvane.datum.sandbox.protocol.PdfKernelDecorator.class, () -> kernel -> new com.argusvane.datum.sandbox.protocol.PdfKernel() {
                    @Override
                    public Program program() {
                        return kernel.program();
                    }

                    @Override
                    public List<String> capabilities() {
                        calls.add("capabilities");
                        return kernel.capabilities();
                    }

                    @Override
                    public ObjectNode call(ObjectNode request) {
                        calls.add("call");
                        return kernel.call(request);
                    }
                })
            .run(context -> {
                assertThat(context).hasNotFailed();
                assertThat(calls).as("the runtime proved the PDF program through the decorated kernel").containsExactly("capabilities");
                com.argusvane.datum.sandbox.runtime.DatumSandbox runtime =
                    context.getBean(com.argusvane.datum.sandbox.runtime.DatumSandbox.class);
                assertThat(runtime.pdfProgram()).isNotInstanceOf(com.argusvane.datum.sandbox.protocol.PdfProgram.class);
                assertThat(context.getBean(KernelRuntime.class).delegate.pdfProbes()).isEqualTo(1);
            });
        runner.withBean(GuestRuntime.class, KernelRuntime::new).run(context -> assertThat(context
            .getBean(com.argusvane.datum.sandbox.runtime.DatumSandbox.class).pdfProgram())
            .as("the default is the program itself").isInstanceOf(com.argusvane.datum.sandbox.protocol.PdfProgram.class));
    }

    /** Two decorator beans in their {@code @Order}: the second does not replace the first. */
    @org.springframework.context.annotation.Configuration(proxyBeanMethods = false)
    static class TwoDecorators {

        static final List<String> CALLS = Collections.synchronizedList(new ArrayList<>());

        @org.springframework.context.annotation.Bean
        @org.springframework.core.annotation.Order(20)
        SandboxDecorator audit() {
            return service -> labelled(service, "audit");
        }

        @org.springframework.context.annotation.Bean
        @org.springframework.core.annotation.Order(10)
        SandboxDecorator tracing() {
            return service -> labelled(service, "tracing");
        }

        static Sandbox labelled(Sandbox delegate, String label) {
            return (Sandbox) Proxy.newProxyInstance(Sandbox.class.getClassLoader(), new Class<?>[] {Sandbox.class}, (proxy, method, args) -> {
                if (method.getName().equals("validate")) {
                    CALLS.add(label);
                }
                try {
                    return method.invoke(delegate, args);
                } catch (InvocationTargetException e) {
                    throw e.getCause();
                }
            });
        }
    }

    @Test
    void twoDecoratorBeansBothSeeEveryRunInTheirOrder() {
        TwoDecorators.CALLS.clear();
        runner.withBean(GuestRuntime.class, KernelRuntime::new).withUserConfiguration(TwoDecorators.class).run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context.getBean(SubmissionReceiver.class).submit(SubmissionRequest.json(), submission()).body()
                .path("status").stringValue()).isEqualTo("accepted");
            // @Order(10) tracing wraps Datum's sandbox first, @Order(20) audit wraps it: audit sees the call first.
            assertThat(TwoDecorators.CALLS).containsExactly("audit", "tracing");
        });
    }

    /**
     * An application's own {@code DatumEventPublisher} bean is not wrapped in the
     * guard, so one that throws (an outbox write that failed) reaches the caller after the handler stored the submission;
     * Datum's default publisher logs a listener's failure instead (SandboxSeams' other tests).
     */
    @Test
    void aThrowingReplacementPublisherReachesTheCaller() {
        List<Object> published = Collections.synchronizedList(new ArrayList<>());
        runner.withBean(GuestRuntime.class, KernelRuntime::new)
            .withBean(com.argusvane.datum.core.DatumEventPublisher.class, () -> event -> {
                published.add(event);
                if (event instanceof com.argusvane.datum.submissions.events.SubmissionValidatedEvent) {
                    throw new IllegalStateException("outbox down");
                }
            })
            .run(context -> {
                assertThat(context).hasNotFailed();
                assertThatThrownBy(() -> context.getBean(SubmissionReceiver.class).submit(SubmissionRequest.json(), submission()))
                    .isInstanceOf(IllegalStateException.class).hasMessage("outbox down");
                assertThat(published).anyMatch(com.argusvane.datum.submissions.events.SubmissionValidatedEvent.class::isInstance);
            });
    }

    /**
     * With an {@code ObservationRegistry} the submission is a {@code datum.submission} observation under
     * the caller's (an HTTP request's, here a stand-in) and its sandbox run a {@code datum.sandbox.run} under it; the runtime's
     * proof and warm-up are observed too; without a registry nothing is wrapped (the first test).
     */
    @Test
    void withAnObservationRegistryTheSubmissionAndItsSandboxRunAreNestedObservations() {
        com.argusvane.datum.core.observation.RecordingObservations recording = new com.argusvane.datum.core.observation.RecordingObservations();
        runner.withBean(GuestRuntime.class, KernelRuntime::new)
            .withBean(io.micrometer.observation.ObservationRegistry.class, recording::registry)
            .run(context -> {
                assertThat(context).hasNotFailed();
                assertThat(recording.named("datum.sandbox.run")).extracting(one -> one.low("op")).contains("abi", "smoke");
                recording.clear();
                io.micrometer.observation.Observation request = io.micrometer.observation.Observation.start("http.server.requests", recording.registry());
                try (io.micrometer.observation.Observation.Scope ignored = request.openScope()) {
                    context.getBean(SubmissionReceiver.class).submit(SubmissionRequest.json(), submission());
                }
                request.stop();
                assertThat(recording.named("datum.submission")).singleElement().satisfies(one -> {
                    assertThat(one.parent()).isEqualTo("http.server.requests");
                    assertThat(one.low()).containsEntry("mode", "submit").containsEntry("channel", "http").containsEntry("outcome", "accepted");
                    assertThat(one.high()).containsEntry("form", "contact");
                });
                assertThat(recording.named("datum.sandbox.run")).singleElement().satisfies(one -> {
                    assertThat(one.parent()).isEqualTo("datum.submission");
                    assertThat(one.low("op")).isEqualTo("validate");
                });
            });
    }

    @Test
    void aBeanPostProcessorAroundTheSandboxBeanSeesTheSameRuns() {
        Map<String, AtomicInteger> counts = new ConcurrentHashMap<>();
        runner.withBean(GuestRuntime.class, KernelRuntime::new)
            .withBean("countingSandbox", BeanPostProcessor.class, () -> new BeanPostProcessor() {
                @Override
                public Object postProcessAfterInitialization(Object bean, String name) {
                    return bean instanceof Sandbox sandbox ? counting(sandbox, counts) : bean;
                }
            })
            .run(context -> {
                assertThat(context).hasNotFailed();
                context.getBean(SubmissionReceiver.class).submit(SubmissionRequest.json(), submission());
                context.getBean(DefinitionService.class).publicCopy((ObjectNode) StrictJson.decode(SECRET));
                assertThat(count(counts, "validate")).isEqualTo(1);
                assertThat(count(counts, "publicCopy")).isEqualTo(1);
            });
    }

    /**
     * The {@code Sandbox} bean is replaceable, as a Spring developer expects, and
     * the decorator chain is applied to whatever bean exists. An application's own sandbox takes the request runs, and the
     * decorator bean still sees every one of them (the receiver's and the definition service's), so a replacement can never skip
     * the decorators. The binding's default is not wrapped twice.
     */
    @Test
    void anApplicationsOwnSandboxBeanTakesTheRequestRunsInsideTheDecorators() {
        Map<String, AtomicInteger> counts = new ConcurrentHashMap<>();
        AtomicInteger replacementRuns = new AtomicInteger();
        AtomicInteger ownRuns = new AtomicInteger();
        runner.withBean(GuestRuntime.class, KernelRuntime::new)
            .withBean(SandboxDecorator.class, () -> service -> counting(service, counts))
            .withBean("applicationSandbox", Sandbox.class, () -> {
                // The application's own sandbox, over the same kind of runtime, counting what reaches it.
                KernelRuntime own = new KernelRuntime();
                SandboxService service = SandboxService.create(ProgramRunner.on(own), Program.of(
                    Program.Kind.SANDBOX, "/* program */".getBytes(StandardCharsets.UTF_8)),
                    new com.argusvane.datum.sandbox.protocol.RunScript("/* freeze */"),
                    com.argusvane.datum.sandbox.protocol.ProgramLimits.defaults(), com.argusvane.datum.sandbox.protocol.HostOptions.defaults());
                return (Sandbox) Proxy.newProxyInstance(Sandbox.class.getClassLoader(), new Class<?>[] {Sandbox.class}, (proxy, method, args) -> {
                    if (method.getName().equals("validate") || method.getName().equals("publicCopy")) {
                        replacementRuns.incrementAndGet();
                    }
                    ownRuns.incrementAndGet();
                    try {
                        return method.invoke(service, args);
                    } catch (InvocationTargetException e) {
                        throw e.getCause();
                    }
                });
            })
            .run(context -> {
                assertThat(context).hasNotFailed();
                assertThat(context.getBeansOfType(Sandbox.class)).containsOnlyKeys("applicationSandbox");
                assertThat(context.getBean(SubmissionReceiver.class).submit(SubmissionRequest.json(), submission()).body()
                    .path("status").stringValue()).isEqualTo("accepted");
                context.getBean(DefinitionService.class).publicCopy((ObjectNode) StrictJson.decode(SECRET));
                assertThat(replacementRuns).as("the application's sandbox ran the request work").hasValue(2);
                assertThat(count(counts, "validate")).as("and the decorator saw the receiver's run").isGreaterThanOrEqualTo(1);
                assertThat(count(counts, "publicCopy")).as("and the definition service's").isEqualTo(1);
            });
    }

    /** The binding's own default is wrapped when the runtime builds it, never a second time by the post-processor. */
    @Test
    void theDefaultSandboxIsNotDecoratedTwice() {
        Map<String, AtomicInteger> counts = new ConcurrentHashMap<>();
        runner.withBean(GuestRuntime.class, KernelRuntime::new)
            .withBean(SandboxDecorator.class, () -> service -> counting(service, counts))
            .run(context -> {
                assertThat(context).hasNotFailed();
                context.getBean(SubmissionReceiver.class).submit(SubmissionRequest.json(), submission());
                assertThat(count(counts, "validate")).isEqualTo(1);
                // An application that publishes the runtime's own sandbox under its own bean is not wrapped again either.
            });
    }

    @Test
    void anApplicationsRunLogReceivesTheGuestsLogOfARealSubmissionOnly() {
        List<String> lines = Collections.synchronizedList(new ArrayList<>());
        runner.withBean(GuestRuntime.class, () -> {
                KernelRuntime runtime = new KernelRuntime();
                runtime.delegate.outcome = context -> {
                    ObjectNode outcome = TestRuntime.accepting(context);
                    outcome.putArray("logs").addObject().put("level", "warn").put("message", "phone contact\nforged line");
                    return outcome;
                };
                return runtime;
            })
            .withBean(RunLog.class, () -> (form, level, message, data) -> lines.add(form + "|" + level + "|" + message))
            .run(context -> {
                assertThat(context).hasNotFailed();
                assertThat(context).hasSingleBean(RunLog.class);
                SubmissionReceiver receiver = context.getBean(SubmissionReceiver.class);
                receiver.submit(SubmissionRequest.json(), submission());
                // The application's sink gets the text as the guest wrote it (the default escapes it for a line log).
                assertThat(lines).containsExactly("contact|warn|phone contact\nforged line");
                receiver.test(SubmissionRequest.json(), submission());
                assertThat(lines).as("a dry run's log is never relayed").hasSize(1);
            });
    }

    /** The log is an observer: an application's RunLog whose sink is down never refuses a real submission. */
    @Test
    void aRunLogBeanThatThrowsStillLetsTheSubmissionBeAccepted() {
        AtomicInteger offered = new AtomicInteger();
        runner.withBean(GuestRuntime.class, () -> {
                KernelRuntime runtime = new KernelRuntime();
                runtime.delegate.outcome = context -> {
                    ObjectNode outcome = TestRuntime.accepting(context);
                    outcome.putArray("logs").addObject().put("level", "info").put("message", "audited");
                    return outcome;
                };
                return runtime;
            })
            .withBean(RunLog.class, () -> (form, level, message, data) -> {
                offered.incrementAndGet();
                throw new IllegalStateException("log shipper unreachable");
            })
            .run(context -> {
                assertThat(context).hasNotFailed();
                assertThat(context.getBean(SubmissionReceiver.class).submit(SubmissionRequest.json(), submission()).body()
                    .path("status").stringValue()).isEqualTo("accepted");
                assertThat(offered).hasValue(1);
            });
    }

    @Test
    void whileTheRuntimeIsDownTheReceiverRefusesThroughTheSharedBeanWithTheRuntimesReason() {
        runner.withPropertyValues("datum.runtime.fail-fast=false").withBean(GuestRuntime.class, () -> {
            KernelRuntime failing = new KernelRuntime();
            failing.delegate.sandboxProbeFails = true;
            return failing;
        }).run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context.getBeanProvider(Sandbox.class).getIfAvailable()).isNull();
            assertThatThrownBy(() -> context.getBean(SubmissionReceiver.class).submit(SubmissionRequest.json(), submission()))
                .isInstanceOf(ProgramUnavailableException.class).hasMessageContaining("abi_mismatch");
            assertThat(context.getBean(DatumSandbox.class).status().state().name()).isEqualTo("DOWN");
        });
    }
}
