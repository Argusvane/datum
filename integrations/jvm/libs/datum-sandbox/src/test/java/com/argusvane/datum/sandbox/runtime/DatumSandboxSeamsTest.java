package com.argusvane.datum.sandbox.runtime;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.core.ProgramUnavailableException;
import com.argusvane.datum.core.contracts.PdfCapabilitiesResponse;
import com.argusvane.datum.core.observation.DatumObservationNames;
import com.argusvane.datum.core.observation.RecordingObservations;
import com.argusvane.datum.sandbox.protocol.AbiProbe;
import com.argusvane.datum.sandbox.protocol.HostOptions;
import com.argusvane.datum.sandbox.protocol.PdfAbi;
import com.argusvane.datum.sandbox.protocol.PdfKernel;
import com.argusvane.datum.sandbox.protocol.PdfKernelDecorator;
import com.argusvane.datum.sandbox.protocol.PdfProgram;
import com.argusvane.datum.sandbox.protocol.Program;
import com.argusvane.datum.sandbox.protocol.ProgramLimits;
import com.argusvane.datum.sandbox.protocol.RunLog;
import com.argusvane.datum.sandbox.protocol.Sandbox;
import com.argusvane.datum.sandbox.protocol.SandboxDecorator;
import com.argusvane.datum.sandbox.protocol.SandboxException;
import com.argusvane.datum.sandbox.protocol.SandboxService;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.node.ObjectNode;

/**
 * The runtime's seams (decorators, not factories): the gate is asked afresh for every proof, the runtime builds the sandbox and the PDF program itself and
 * hands them to the host's decorators in order, so what they answer is what the proof, the warm-up and every run go
 * through; Datum's own observation of every guest run sits directly around the protocol; the slots tell the run
 * observer of every busy refusal; the run log is the one handed in.
 */
class DatumSandboxSeamsTest {

    private final TestRuntime engine = new TestRuntime();
    private final ExecutorService callers = Executors.newCachedThreadPool();
    private DatumSandbox runtime;

    @AfterEach
    void tearDown() {
        if (runtime != null) {
            runtime.stop();
        }
        callers.shutdownNow();
    }

    /** A decorator through the interface: counts each call by method name (with a label), then delegates. */
    static Sandbox counting(Sandbox delegate, Map<String, AtomicInteger> counts, List<String> order, String label) {
        return (Sandbox) Proxy.newProxyInstance(Sandbox.class.getClassLoader(), new Class<?>[] {Sandbox.class}, (proxy, method, args) -> {
            counts.computeIfAbsent(method.getName(), name -> new AtomicInteger()).incrementAndGet();
            if (order != null && !"program".equals(method.getName())) {
                order.add(label + ":" + method.getName());
            }
            try {
                return method.invoke(delegate, args);
            } catch (InvocationTargetException e) {
                throw e.getCause();
            }
        });
    }

    static Sandbox counting(Sandbox delegate, Map<String, AtomicInteger> counts) {
        return counting(delegate, counts, null, "");
    }

    private static SandboxSettings settings(int warmUps) {
        return TestSettings.of("endive", true, warmUps, Duration.ofSeconds(1), 1, Duration.ZERO);
    }

    private DatumSandbox runtime(RunLog log, java.util.function.Supplier<AbiProbe> probes, List<SandboxDecorator> decorators, int warmUps) {
        runtime = DatumSandbox.builder().runtime(engine).store(Programs.packaged().store()).limits(ProgramLimits.defaults()).hostOptions(HostOptions.defaults()).settings(settings(warmUps))
            .events(event -> { }).runLog(log).probes(probes).sandboxDecorators(decorators).pdfKernelDecorators(List.of()).build();
        return runtime;
    }

    private static ObjectNode context() {
        return TestRuntime.json("{\"formId\":\"contact\",\"form\":{\"id\":\"root\",\"type\":\"form\",\"configuration\":{},\"children\":{\"content\":[]}},"
            + "\"values\":{},\"locale\":\"en\"}");
    }

    @Test
    void theDecoratedSandboxCarriesTheProofTheWarmUpsAndEveryRun() {
        Map<String, AtomicInteger> counts = new ConcurrentHashMap<>();
        DatumSandbox started = runtime(RunLog.slf4j(), AbiProbe::new, List.of(service -> counting(service, counts)), 2);
        started.start();
        assertThat(counts.get("proveAbi")).hasValue(1);
        assertThat(counts.get("smoke")).hasValue(2);
        started.sandbox().validate(context(), List.of(), false);
        // A smoke is one call of its own (its validation runs inside the service), so the request is the one validate seen.
        assertThat(counts.get("validate")).hasValue(1);
        assertThat(engine.validations()).isEqualTo(1);
        assertThat(Proxy.isProxyClass(started.sandbox().getClass())).as("the callers get the decorated sandbox").isTrue();
        assertThat(started.sandboxOrNull()).isSameAs(started.sandbox());
    }

    /**
     * A sandbox that is not the runtime's (a replacement bean in a binding) is wrapped in the same chain: the
     * host's decorators see its runs, and in the same order as for the runtime's own.
     */
    @Test
    void aSandboxThatIsNotTheRuntimesOwnGoesThroughTheSameChain() {
        Map<String, AtomicInteger> tracing = new ConcurrentHashMap<>();
        Map<String, AtomicInteger> audit = new ConcurrentHashMap<>();
        List<String> order = Collections.synchronizedList(new ArrayList<>());
        DatumSandbox started = runtime(RunLog.slf4j(), AbiProbe::new, List.of(
            service -> counting(service, tracing, order, "tracing"), service -> counting(service, audit, order, "audit")), 1);
        started.start();
        order.clear();
        AtomicInteger replacementRuns = new AtomicInteger();
        Sandbox own = started.sandbox();
        Sandbox replacement = (Sandbox) Proxy.newProxyInstance(Sandbox.class.getClassLoader(), new Class<?>[] {Sandbox.class}, (proxy, method, args) -> {
            replacementRuns.incrementAndGet();
            try {
                return method.invoke(own, args);
            } catch (InvocationTargetException e) {
                throw e.getCause();
            }
        });
        Sandbox decorated = started.decorate(replacement);
        assertThat(decorated).isNotSameAs(replacement);
        // Before the replacement runs, the proof and warm-up of the runtime's own sandbox are already counted: count from here.
        int validatesBefore = tracing.get("validate") == null ? 0 : tracing.get("validate").get();
        decorated.validate(context(), List.of(), false);
        assertThat(replacementRuns).as("the replacement ran the work").hasValue(1);
        assertThat(tracing.get("validate").get() - validatesBefore).isEqualTo(2);
        assertThat(order.stream().filter(entry -> entry.endsWith(":validate")).toList())
            .as("the last decorator first, once around the replacement and once more inside it because the test delegates to the runtime's own")
            .startsWith("audit:validate", "tracing:validate");
    }

    /**
     * Two parties decorate at once (the application's tracing and an audit library): both see every run, the first given
     * wrapping the runtime's sandbox and the last seeing each call first, as Spring Boot composes its task decorators.
     */
    @Test
    void twoDecoratorsBothSeeEveryRunInTheirOrder() {
        Map<String, AtomicInteger> tracing = new ConcurrentHashMap<>();
        Map<String, AtomicInteger> audit = new ConcurrentHashMap<>();
        List<String> order = Collections.synchronizedList(new ArrayList<>());
        DatumSandbox started = runtime(RunLog.slf4j(), AbiProbe::new, List.of(
            service -> counting(service, tracing, order, "tracing"), service -> counting(service, audit, order, "audit")), 1);
        started.start();
        started.sandbox().validate(context(), List.of(), false);
        assertThat(tracing.get("validate")).hasValue(1);
        assertThat(audit.get("validate")).hasValue(1);
        assertThat(tracing.get("proveAbi")).hasValue(1);
        assertThat(audit.get("proveAbi")).hasValue(1);
        assertThat(order).containsExactly("audit:proveAbi", "tracing:proveAbi", "audit:smoke", "tracing:smoke", "audit:validate",
            "tracing:validate");
        assertThat(engine.validations()).as("one run, whatever the decorators").isEqualTo(1);
    }

    /**
     * The PDF program's runs go through the host's {@link PdfKernelDecorator}s as the sandbox's go through its
     * sandbox decorators, so one observer in both sees every guest run: the PDF program's ABI proof and every PDF call.
     */
    @Test
    void thePdfKernelDecoratorsCarryThePdfProofAndEveryPdfRun() {
        List<String> calls = Collections.synchronizedList(new ArrayList<>());
        Map<String, AtomicInteger> sandboxCalls = new ConcurrentHashMap<>();
        PdfKernelDecorator observed = program -> new PdfKernel() {
            @Override
            public Program program() {
                return program.program();
            }

            @Override
            public PdfCapabilitiesResponse capabilities() {
                calls.add("capabilities");
                return program.capabilities();
            }

            @Override
            public ObjectNode call(ObjectNode request) {
                calls.add("call:" + request.path("op").asString(""));
                return program.call(request);
            }
        };
        runtime = DatumSandbox.builder().runtime(engine).store(Programs.packaged().store()).limits(ProgramLimits.defaults()).hostOptions(HostOptions.defaults()).settings(settings(1))
            .events(event -> { }).runLog(RunLog.slf4j()).probes(AbiProbe::new).sandboxDecorators(List.of(service -> counting(service, sandboxCalls))).pdfKernelDecorators(List.of(observed)).build();
        runtime.start();
        assertThat(calls).as("the PDF program's ABI proof went through the decorated kernel").containsExactly("capabilities");
        assertThat(engine.pdfProbes()).isEqualTo(1);
        assertThat(sandboxCalls.get("proveAbi")).as("and the sandbox's through its own").hasValue(1);
        assertThat(runtime.pdfProgram()).as("the callers get the decorated kernel").isNotInstanceOf(PdfProgram.class);
        assertThat(runtime.pdfProgram().capabilities().abi()).isEqualTo(PdfAbi.MIN);
        assertThat(calls).containsExactly("capabilities", "capabilities");
        assertThat(engine.pdfProbes()).as("the gate remembers the proof: no second run").isEqualTo(1);

        runtime.recheck();
        assertThat(engine.pdfProbes()).as("a recheck proves the PDF program again through a new kernel").isEqualTo(2);
        assertThat(PdfAbi.MIN).isEqualTo("1.0.0");
    }

    @Test
    void aDecoratorThatAnswersNothingKeepsTheRuntimeDown() {
        runtime = DatumSandbox.builder().runtime(engine).store(Programs.packaged().store()).limits(ProgramLimits.defaults()).hostOptions(HostOptions.defaults()).settings(settings(0))
            .events(event -> { }).runLog(RunLog.slf4j()).probes(AbiProbe::new).sandboxDecorators(List.of()).pdfKernelDecorators(List.of(kernel -> null)).build();
        assertThatThrownBy(runtime::start).hasMessageContaining("PDF kernel decorator").hasMessageContaining("answered null");
        DatumSandbox nothing = runtime(RunLog.slf4j(), AbiProbe::new, List.of(service -> null), 0);
        assertThatThrownBy(nothing::start).hasMessageContaining("sandbox decorator").hasMessageContaining("answered null");
        assertThat(nothing.sandboxOrNull()).isNull();
    }

    @Test
    void eachProofTakesAFreshGateFromTheSupplier() {
        List<AbiProbe> handed = Collections.synchronizedList(new ArrayList<>());
        DatumSandbox started = runtime(RunLog.slf4j(), () -> {
            AbiProbe probe = new AbiProbe();
            handed.add(probe);
            return probe;
        }, List.of(), 0);
        started.start();
        started.recheck();
        assertThat(handed).hasSize(2).doesNotHaveDuplicates();
        assertThat(engine.sandboxProbes()).as("the recheck proved the program again").isEqualTo(2);
        assertThat(started.sandbox()).as("no decorator, no observations: the protocol itself").isInstanceOf(SandboxService.class);
        assertThat(started.pdfProgram()).isInstanceOf(PdfProgram.class);
    }

    @Test
    void aSharedGateIsUsedButTheRecheckDoesNotAskTheSameProgramAgain() {
        AbiProbe shared = new AbiProbe();
        DatumSandbox started = runtime(RunLog.slf4j(), () -> shared, List.of(), 0);
        started.start();
        started.recheck();
        assertThat(engine.sandboxProbes()).as("a remembered proof of the same file (with a WARN)").isEqualTo(1);
        assertThat(started.status().state()).isEqualTo(SandboxStatus.State.UP);
    }

    @Test
    void aSupplierThatAnswersNothingKeepsTheRuntimeDown() {
        DatumSandbox noGate = runtime(RunLog.slf4j(), () -> null, List.of(), 0);
        assertThatThrownBy(noGate::start).hasMessageContaining("AbiProbe supplier answered null");
        assertThat(noGate.sandboxOrNull()).isNull();
        assertThat(noGate.sandboxUnavailable()).isInstanceOf(ProgramUnavailableException.class)
            .hasMessageStartingWith("Submissions cannot be checked right now: ");
    }

    @Test
    void aRealRunsLogGoesToTheRunLogHandedIn() {
        List<String> lines = Collections.synchronizedList(new ArrayList<>());
        engine.outcome = context -> {
            ObjectNode outcome = TestRuntime.accepting(context);
            outcome.putArray("logs").addObject().put("level", "warn").put("message", "phone contact");
            return outcome;
        };
        DatumSandbox started = runtime((form, level, message, data) -> lines.add(form + "|" + level + "|" + message), AbiProbe::new,
            List.of(), 1);
        started.start();
        started.sandbox().validate(context(), List.of(), true);
        started.sandbox().validate(context(), List.of(), false);
        assertThat(lines).as("a real run's entry, never the dry run's or the smoke's").containsExactly("contact|warn|phone contact");
    }

    /**
     * With observations every guest run is observed directly around the protocol, under the host's
     * decorators: the proof and warm-ups as {@code datum.sandbox.run} (op abi, smoke), the PDF program's proof as
     * {@code datum.pdf.run}, each tagged with the engine's mode; an application decorator's own span then encloses Datum's.
     */
    @Test
    void withObservationsEveryGuestRunIsObservedInsideTheHostsDecorators() {
        RecordingObservations recording = new RecordingObservations();
        List<String> order = Collections.synchronizedList(new ArrayList<>());
        SandboxDecorator tracing = service -> counting(service, new ConcurrentHashMap<>(), order, "tracing");
        runtime = DatumSandbox.builder().runtime(engine).store(Programs.packaged().store()).limits(ProgramLimits.defaults()).hostOptions(HostOptions.defaults()).settings(settings(1))
            .events(event -> { }).runLog(RunLog.slf4j()).probes(AbiProbe::new).sandboxDecorators(List.of(tracing)).pdfKernelDecorators(List.of()).observations(recording.observations()).build();
        runtime.start();
        runtime.sandbox().validate(context(), List.of(), false);
        assertThat(recording.named(DatumObservationNames.SANDBOX_RUN)).extracting(one -> one.low("op"))
            .containsExactly("abi", "smoke", "validate");
        assertThat(recording.named(DatumObservationNames.SANDBOX_RUN)).allSatisfy(one -> {
            assertThat(one.low("engine.mode")).isEqualTo(engine.mode);
            assertThat(one.low("outcome")).isEqualTo("ok");
        });
        assertThat(recording.named(DatumObservationNames.PDF_RUN)).extracting(one -> one.low("op")).containsExactly("capabilities");
        assertThat(order).as("the application's decorator still sees every call").contains("tracing:validate");
        Object outer = runtime.sandbox();
        assertThat(Proxy.isProxyClass(outer.getClass())).as("the application's decorator is outermost").isTrue();
    }

    /**
     * The slots tell the run observer of every busy refusal, whoever asked, so {@code datum.runs.rejected}
     * counts the queue, batch and sync channels and the definition service as well as the HTTP routes.
     */
    @Test
    void everyBusyRefusalIsToldToTheRunObserver() throws Exception {
        List<Program.Kind> refused = Collections.synchronizedList(new ArrayList<>());
        ProgramLimits one = ProgramLimits.builder().validationConcurrency(1).validationWait(0).build();
        runtime = DatumSandbox.builder().runtime(engine).store(Programs.packaged().store()).limits(one).hostOptions(HostOptions.defaults()).settings(settings(0)).events(event -> { })
            .runLog(RunLog.slf4j()).probes(AbiProbe::new).sandboxDecorators(List.of()).pdfKernelDecorators(List.of()).build();
        runtime.observer(new DatumSandbox.RunObserver() {
            @Override
            public void ran(Program.Kind kind, String outcome, Duration elapsed) {
            }

            @Override
            public void refused(Program.Kind kind) {
                refused.add(kind);
            }
        });
        runtime.start();
        engine.hold = new CountDownLatch(1);
        engine.holding = new CountDownLatch(1);
        DatumSandbox busy = runtime;
        Future<?> first = callers.submit(() -> busy.sandbox().validate(context(), List.of(), false));
        assertThat(engine.holding.await(5, TimeUnit.SECONDS)).isTrue();
        assertThatThrownBy(() -> busy.sandbox().validate(context(), List.of(), false))
            .isInstanceOfSatisfying(SandboxException.class, e -> assertThat(e.reason()).isEqualTo(SandboxException.Reason.BUSY));
        try (var pdf = busy.pdfSlots().acquire()) {
            assertThatThrownBy(() -> busy.pdfSlots().acquire()).isInstanceOf(SandboxException.class);
        }
        engine.hold.countDown();
        first.get(5, TimeUnit.SECONDS);
        assertThat(refused).containsExactly(Program.Kind.SANDBOX, Program.Kind.PDF);
    }
}
