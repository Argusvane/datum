package com.argusvane.datum.sandbox.runtime;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.core.DatumConfigurationException;
import com.argusvane.datum.sandbox.diagnostics.DirectoryCaptureSink;
import com.argusvane.datum.sandbox.diagnostics.RunCapture;
import com.argusvane.datum.sandbox.diagnostics.RunCaptureSink;
import com.argusvane.datum.sandbox.diagnostics.RunTrace;
import com.argusvane.datum.sandbox.diagnostics.SettingsReport.Entry;
import com.argusvane.datum.sandbox.diagnostics.SettingsReport.Source;
import com.argusvane.datum.sandbox.protocol.HostOptions;
import com.argusvane.datum.sandbox.protocol.ProgramLimits;
import com.argusvane.datum.sandbox.protocol.RunSlots;
import com.argusvane.datum.sandbox.protocol.SandboxException;
import com.argusvane.datum.sandbox.protocol.SandboxResult;
import com.argusvane.datum.sandbox.wasi.EngineInfo;
import com.argusvane.datum.sandbox.wasi.EngineSettings;
import com.argusvane.datum.sandbox.wasi.GuestRun;
import com.argusvane.datum.sandbox.wasi.GuestRuntime;
import com.argusvane.datum.sandbox.wasi.RunOutput;
import com.argusvane.datum.sandbox.wasi.Termination;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;
import java.util.stream.Stream;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.node.ObjectNode;

/**
 * The sandbox's diagnostics over a scripted runtime: the trace line per mode, its fields and what it
 * never holds; a trace that is off costs nothing in the run path; the capture keeps a failed run and nothing else; a capture or
 * a trace that fails never changes an answer; the startup report and the effective-settings report.
 */
class DatumSandboxDiagnosticsTest {

    /** A marker in the answers, which no trace line may carry. */
    private static final String MARKER = "MARKER-7f3a-answer";

    private static final List<String> FIELDS = List.of("run", "program", "op", "abi", "engine", "mode", "slotWaitMs", "prepareMs",
        "instantiateMs", "startMs", "totalMs", "termination", "exit", "outcome", "stdinBytes", "stdoutBytes", "stderrBytes", "capture");

    @TempDir
    Path temp;

    private final TestRuntime engine = new TestRuntime();
    private final Spy spy = new Spy(engine);
    private final List<String> lines = Collections.synchronizedList(new ArrayList<>());
    private final List<String> order = Collections.synchronizedList(new ArrayList<>());
    private final ExecutorService callers = Executors.newCachedThreadPool();
    private DatumSandbox sandbox;

    @AfterEach
    void tearDown() {
        if (sandbox != null) {
            sandbox.close();
        }
        callers.shutdownNow();
    }

    /** The engine as the sandbox sees it, keeping every guest run it was handed. */
    private final class Spy implements GuestRuntime {

        final TestRuntime inner;
        final List<GuestRun> runs = Collections.synchronizedList(new ArrayList<>());
        final List<RunOutput> outputs = Collections.synchronizedList(new ArrayList<>());
        /** When set, every run waits for it deaf to the interrupt of a cancel: a runtime that does not enforce its budget. */
        volatile CountDownLatch stall;

        Spy(TestRuntime inner) {
            this.inner = inner;
        }

        @Override
        public RunOutput run(GuestRun run) {
            order.add("run");
            runs.add(run);
            CountDownLatch gate = stall;
            while (gate != null) {
                try {
                    gate.await();
                    return RunOutput.exited(0, new byte[0], null);
                } catch (InterruptedException e) {
                    // Deaf to the cancel, as a stuck guest is.
                }
            }
            RunOutput output = inner.run(run);
            outputs.add(output);
            return output;
        }

        @Override
        public EngineInfo engineInfo() {
            return inner.engineInfo();
        }

        /** Every nonce the sandbox program was sent: the first 32 characters of its stdin. */
        List<String> nonces() {
            List<String> nonces = new ArrayList<>();
            synchronized (runs) {
                for (GuestRun run : runs) {
                    if (run.file("datum-sandbox-program.js") != null) {
                        nonces.add(new String(run.stdinBytes(), StandardCharsets.UTF_8).substring(0, 32));
                    }
                }
            }
            return nonces;
        }
    }

    /** A sink in memory. */
    private static final class MemorySink implements RunCaptureSink {

        final List<RunCapture> written = Collections.synchronizedList(new ArrayList<>());
        volatile IOException failure;

        @Override
        public long write(RunCapture capture) throws IOException {
            if (failure != null) {
                throw failure;
            }
            written.add(capture);
            return capture.bytes();
        }

        @Override
        public void remove(String id) {
            written.removeIf(capture -> capture.id().equals(id));
        }

        @Override
        public String describe() {
            return "the test's memory";
        }
    }

    private SandboxSettings.Builder settings() {
        return TestSettings.builder("endive", true, 1, Duration.ofSeconds(1), 1, Duration.ZERO);
    }

    private DatumSandbox sandbox(SandboxSettings settings, Consumer<DatumSandbox.Builder> more) {
        DatumSandbox.Builder builder = DatumSandbox.builder().runtime(spy).store(Programs.packaged().store()).settings(settings)
            .runTrace(RunTrace.lines(lines::add)).reportLog(text -> order.add("report:" + text));
        more.accept(builder);
        sandbox = builder.build();
        return sandbox;
    }

    private DatumSandbox sandbox(SandboxSettings settings) {
        return sandbox(settings, builder -> { });
    }

    private static ObjectNode context(String name) {
        return TestRuntime.json("{\"formId\":\"contact\",\"form\":{\"id\":\"root\",\"type\":\"form\",\"configuration\":{},\"children\":{\"content\":[]}},"
            + "\"values\":{\"name\":\"" + name + "\"},\"locale\":\"en\"}");
    }

    private static List<String> keys(String line) {
        return Stream.of(line.split(" ")).map(pair -> pair.substring(0, pair.indexOf('='))).toList();
    }

    private static String field(String line, String key) {
        return Stream.of(line.split(" ")).filter(pair -> pair.startsWith(key + "=")).map(pair -> pair.substring(key.length() + 1))
            .findFirst().orElseThrow();
    }

    private static void eventually(java.util.function.BooleanSupplier condition) throws InterruptedException {
        long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (!condition.getAsBoolean() && System.nanoTime() < until) {
            Thread.sleep(5);
        }
        assertThat(condition.getAsBoolean()).as("in time").isTrue();
    }

    // ============================================================================================== the trace

    @Test
    void traceAllWritesOneLinePerRunInTheFixedOrderWithNoAnswerAndNoNonce() {
        DatumSandbox traced = sandbox(settings().trace("all").build());
        traced.start();
        assertThat(lines).as("the ABI probe, the PDF capabilities and one warm-up").hasSize(3);
        SandboxResult result = traced.sandbox().validate(context(MARKER), List.of(), true);
        assertThat(result.outcome().path("values").path("name").asString()).isEqualTo(MARKER);
        assertThat(lines).hasSize(4);

        for (String line : lines) {
            assertThat(keys(line)).containsExactlyElementsOf(FIELDS);
            assertThat(line).doesNotContain(MARKER).doesNotContain("datum-smoke").doesNotContain("Name");
            for (String nonce : spy.nonces()) {
                assertThat(line).as("never the run's nonce").doesNotContain(nonce);
            }
            assertThat(field(line, "run")).matches("[0-9a-f]{12}");
        }
        assertThat(lines.stream().map(line -> field(line, "program") + ":" + field(line, "op")).toList())
            .containsExactly("sandbox:abi", "pdf:capabilities", "sandbox:validate", "sandbox:validate");
        String validation = lines.get(3);
        assertThat(field(validation, "abi")).isEqualTo("2.14.0");
        assertThat(field(validation, "engine")).isEqualTo(TestRuntime.class.getName());
        assertThat(field(validation, "mode")).isEqualTo("jffi");
        assertThat(field(validation, "termination")).isEqualTo("exited");
        assertThat(field(validation, "exit")).isEqualTo("0");
        assertThat(field(validation, "outcome")).isEqualTo("verdict");
        assertThat(field(validation, "slotWaitMs")).as("a validation holds a slot").matches("[0-9]+\\.[0-9]");
        assertThat(field(validation, "stdinBytes")).isEqualTo(String.valueOf(spy.runs.get(3).stdin().remaining()));
        assertThat(field(validation, "stdoutBytes")).isEqualTo(String.valueOf(spy.outputs.get(3).stdoutLength()));
        assertThat(field(validation, "capture")).isEqualTo("-");
        assertThat(field(lines.get(1), "abi")).isEqualTo("4.0.0");
        assertThat(field(lines.get(1), "slotWaitMs")).as("the PDF probe takes no slot").isEqualTo("-");
        assertThat(spy.runs).as("every run asks the harness for its timings").allMatch(GuestRun::timed);
    }

    @Test
    void traceFailuresSkipsANormalVerdictAndTracesAFailedRun() {
        DatumSandbox traced = sandbox(settings().trace("failures").build());
        traced.start();
        traced.sandbox().validate(context("Ada"), List.of(), false);
        assertThat(lines).as("no failed run yet: the proofs, the warm-up and the verdict are not traced").isEmpty();

        engine.terminate = Termination.TRAP;
        assertThatThrownBy(() -> traced.sandbox().validate(context(MARKER), List.of(), false)).isInstanceOfSatisfying(SandboxException.class,
            e -> assertThat(e.reason()).isEqualTo(SandboxException.Reason.TRAP));
        assertThat(lines).singleElement().satisfies(line -> {
            assertThat(field(line, "outcome")).isEqualTo("trap");
            assertThat(field(line, "termination")).isEqualTo("trap");
            assertThat(field(line, "exit")).isEqualTo("-");
            assertThat(line).doesNotContain(MARKER);
        });

        engine.terminate = null;
        engine.failValidations = new com.argusvane.datum.sandbox.wasi.GuestUnavailableException("cannot start");
        assertThatThrownBy(() -> traced.sandbox().validate(context("Ada"), List.of(), false))
            .isInstanceOf(com.argusvane.datum.core.ProgramUnavailableException.class);
        assertThat(lines).hasSize(2);
        assertThat(field(lines.get(1), "outcome")).isEqualTo("unavailable");
        assertThat(field(lines.get(1), "termination")).as("no run came back").isEqualTo("-");
    }

    /**
     * A run that would not stop past the backstop and its stop wait: the trace keeps it apart from an ordinary budget stop
     * by its termination ({@code stuck}) while its outcome is the word its caller is answered with ({@code budget}).
     */
    @Test
    void aStuckRunIsTracedAsStuckWithTheBudgetOutcome() throws Exception {
        DatumSandbox traced = sandbox(settings().trace("failures").validationTimeLimit(Duration.ofSeconds(1)).build());
        traced.start();
        traced.timeouts(Duration.ofMillis(100), Duration.ofMillis(200));
        CountDownLatch release = new CountDownLatch(1);
        spy.stall = release;
        try {
            assertThatThrownBy(() -> traced.sandbox().validate(context(MARKER), List.of(), false))
                .isInstanceOfSatisfying(SandboxException.class, e -> assertThat(e.reason()).isEqualTo(SandboxException.Reason.BUDGET));
            assertThat(traced.stuckRuns()).isEqualTo(1);
            eventually(() -> lines.size() == 1);
            assertThat(lines).singleElement().satisfies(line -> {
                assertThat(field(line, "outcome")).isEqualTo("budget");
                assertThat(field(line, "termination")).isEqualTo("stuck");
                assertThat(field(line, "exit")).isEqualTo("-");
                assertThat(line).doesNotContain(MARKER);
            });
        } finally {
            spy.stall = null;
            release.countDown();
        }
        eventually(() -> traced.stuckRuns() == 0);
    }

    @Test
    void aTraceThatIsOffMeasuresFormatsAndAllocatesNothingInTheRunPath() {
        AtomicInteger traced = new AtomicInteger();
        DatumSandbox quiet = sandbox(settings().build(), builder -> builder.runTrace(record -> traced.incrementAndGet()));
        quiet.start();
        quiet.sandbox().validate(context(MARKER), List.of(), true);
        engine.terminate = Termination.TRAP;
        assertThatThrownBy(() -> quiet.sandbox().validate(context("Ada"), List.of(), false)).isInstanceOf(SandboxException.class);

        assertThat(traced).as("the trace seam is never called").hasValue(0);
        assertThat(lines).as("the formatter is never called").isEmpty();
        assertThat(spy.runs).isNotEmpty().as("no run asks for timings").noneMatch(GuestRun::timed);
        // The services this sandbox built hold no recorder, so no run makes a watch (RunWatch.start of none is none).
        assertThat(quiet.sandbox()).isInstanceOf(com.argusvane.datum.sandbox.protocol.SandboxService.class);
        assertThat(com.argusvane.datum.sandbox.protocol.Recorders.of(quiet.sandbox())).isNull();
        assertThat(com.argusvane.datum.sandbox.protocol.Recorders.of(quiet.pdfProgram())).isNull();
        try (RunSlots.Permit ignored = quiet.validationSlots().acquire()) {
            assertThat(quiet.validationSlots().heldWaitNanos()).as("the slots read no clock and keep nothing per thread").isEqualTo(-1);
        }
        assertThat(quiet.status().details()).as("health is what it was").doesNotContainKey("capture");
    }

    @Test
    void aWatchedSandboxMeasuresItsSlotWait() {
        DatumSandbox traced = sandbox(settings().trace("failures").build());
        traced.start();
        assertThat(com.argusvane.datum.sandbox.protocol.Recorders.of(traced.sandbox())).as("a watched sandbox's services hold one").isNotNull();
        assertThat(com.argusvane.datum.sandbox.protocol.Recorders.of(traced.pdfProgram())).isNotNull();
        try (RunSlots.Permit ignored = traced.validationSlots().acquire()) {
            assertThat(traced.validationSlots().heldWaitNanos()).isGreaterThanOrEqualTo(0);
        }
        assertThat(traced.validationSlots().heldWaitNanos()).as("released with its permit").isEqualTo(-1);
    }

    // ============================================================================================== the capture

    @Test
    void theCaptureKeepsAFailedRunAndNothingForAVerdictOrABusyRefusal() throws Exception {
        MemorySink sink = new MemorySink();
        DatumSandbox capturing = sandbox(settings().trace("all").captureEnabled(true).validationConcurrency(1).validationWait(Duration.ZERO).build(),
            builder -> builder.captureSink(sink));
        capturing.start();
        capturing.sandbox().validate(context("Ada"), List.of(), false);
        assertThat(lines).allSatisfy(line -> assertThat(field(line, "capture")).isEqualTo("-"));

        // A busy refusal: one validation holds the only slot, the next is refused before any run is made.
        int linesBefore = lines.size();
        engine.hold = new CountDownLatch(1);
        engine.holding = new CountDownLatch(1);
        Future<SandboxResult> held = callers.submit(() -> capturing.sandbox().validate(context("Ada"), List.of(), false));
        assertThat(engine.holding.await(5, TimeUnit.SECONDS)).isTrue();
        assertThatThrownBy(() -> capturing.sandbox().validate(context("Ada"), List.of(), false)).isInstanceOfSatisfying(SandboxException.class,
            e -> assertThat(e.reason()).isEqualTo(SandboxException.Reason.BUSY));
        engine.hold.countDown();
        held.get(5, TimeUnit.SECONDS);
        engine.hold = null;
        assertThat(lines).as("the refused run was never made, so it has no line").hasSize(linesBefore + 1);
        assertThat(sink.written).as("no capture for a verdict or a busy refusal").isEmpty();

        engine.terminate = Termination.TRAP;
        assertThatThrownBy(() -> capturing.sandbox().validate(context(MARKER), List.of(), false)).isInstanceOf(SandboxException.class);
        eventually(() -> sink.written.size() == 1);
        RunCapture capture = sink.written.get(0);
        assertThat(capture.id()).matches(RunCapture.ID);
        assertThat(capture.files().keySet()).containsExactlyElementsOf(RunCapture.FILES);
        String stdin = text(capture.files().get("stdin.bin"));
        assertThat(stdin).as("the capture holds the answers, as the WARN says").contains(MARKER);
        assertThat(text(capture.files().get("run.js"))).contains("__datum_run");
        String meta = text(capture.files().get("meta.json"));
        assertThat(meta).contains("\"capture\" : \"" + capture.id() + "\"").contains("\"outcome\" : \"trap\"")
            .contains("\"sha256\" : \"" + Programs.packaged().store().load().sandbox().sha256() + "\"").contains("\"abi\" : \"2.14.0\"")
            .contains(TestRuntime.class.getName()).contains("datum.runtime.diagnostics.capture.enabled").contains("\"entries\"");
        String line = lines.get(lines.size() - 1);
        assertThat(field(line, "capture")).isEqualTo(capture.id());
        assertThat(line).doesNotContain(MARKER);
        assertThat(capturing.status().details()).containsEntry("capture", Map.of("dropped", 0L, "failed", 0L));
    }

    private static String text(ByteBuffer buffer) {
        byte[] bytes = new byte[buffer.remaining()];
        buffer.get(bytes);
        return new String(bytes, StandardCharsets.UTF_8);
    }

    @Test
    void aSinkThatFailsAndATraceThatThrowsLeaveEveryAnswerUnchanged() throws Exception {
        MemorySink sink = new MemorySink();
        sink.failure = new IOException("disk full");
        DatumSandbox fragile = sandbox(settings().trace("all").captureEnabled(true).build(), builder -> builder.captureSink(sink)
            .runTrace(record -> {
                throw new IllegalStateException("trace sink down");
            }));
        fragile.start();
        SandboxResult verdict = fragile.sandbox().validate(context("Ada"), List.of(), false);
        assertThat(verdict.outcome().path("errors").isEmpty()).isTrue();

        engine.terminate = Termination.TRAP;
        Throwable failed = org.assertj.core.api.Assertions.catchThrowable(() -> fragile.sandbox().validate(context("Ada"), List.of(), false));
        assertThat(failed).isInstanceOfSatisfying(SandboxException.class, e -> {
            assertThat(e.reason()).isEqualTo(SandboxException.Reason.TRAP);
            assertThat(e.getMessage()).isEqualTo("The sandbox program trapped.");
        });
        eventually(() -> fragile.captureCounts().failed() == 1);
        assertThat(fragile.status().details()).containsEntry("capture", Map.of("dropped", 0L, "failed", 1L));
        assertThat(fragile.status().isUp()).isTrue();
    }

    @Test
    void theCaptureNeedsADirectoryOrASinkOfTheHostsOwn() {
        assertThatThrownBy(() -> sandbox(settings().captureEnabled(true).build())).isInstanceOfSatisfying(DatumConfigurationException.class,
            e -> assertThat(e.property()).isEqualTo(DirectoryCaptureSink.PROPERTY));
        sandbox(settings().captureEnabled(true).build(), builder -> builder.captureSink(new MemorySink()));
    }

    @Test
    void aRefusedCaptureDirectoryStopsTheStartWhateverFailFastSays() throws IOException {
        Path loose = temp.resolve("loose");
        Files.createDirectory(loose, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwxr-xr-x")));
        DatumSandbox refused = sandbox(TestSettings.builder("endive", false, 1, Duration.ofSeconds(1), 1, Duration.ZERO).captureEnabled(true)
            .captureDirectory(loose.toString()).build());
        assertThatThrownBy(refused::start).isInstanceOf(DatumConfigurationException.class).hasMessageContaining("rwxr-xr-x");
        assertThat(refused.isRunning()).isFalse();
        assertThat(refused.status().state()).isEqualTo(SandboxStatus.State.DOWN);
        assertThat(refused.status().reason()).as("the health reason names no path").doesNotContain(loose.toString());
        assertThat(spy.runs).as("nothing was run").isEmpty();
        assertThatThrownBy(refused::sandbox).isInstanceOf(com.argusvane.datum.core.ProgramUnavailableException.class);
    }

    @Test
    void stopWritesWhatTheCaptureHolds() throws Exception {
        Path directory = temp.resolve("captures");
        DatumSandbox capturing = sandbox(settings().captureEnabled(true).captureDirectory(directory.toString()).build());
        capturing.start();
        engine.terminate = Termination.OUTPUT_CAP;
        for (int i = 0; i < 3; i++) {
            assertThatThrownBy(() -> capturing.sandbox().validate(context("Ada"), List.of(), false)).isInstanceOf(SandboxException.class);
        }
        capturing.stop();
        try (Stream<Path> entries = Files.list(directory)) {
            assertThat(entries.map(path -> path.getFileName().toString()).toList()).hasSize(3).allMatch(name -> RunCapture.ID.matcher(name).matches());
        }
        assertThat(PosixFilePermissions.toString(Files.getPosixFilePermissions(directory))).isEqualTo("rwx------");
    }

    // ============================================================================================== the report

    @Test
    void theStartLogsTheReportBeforeAnythingIsProved() {
        DatumSandbox started = sandbox(settings().validationTimeLimit(Duration.ofSeconds(90)).build());
        started.start();
        assertThat(order.get(0)).startsWith("report:");
        assertThat(order.subList(1, order.size())).as("then the proof runs").isNotEmpty().allMatch("run"::equals);
        String report = order.get(0).substring("report:".length());
        String sha = Programs.packaged().store().load().sandbox().sha256();
        assertThat(report).startsWith("Datum sandbox settings:")
            .contains("datum.runtime.validation.time-limit = PT1M (clamped from PT1M30S to whole seconds in [1, 60])")
            .contains("datum.runtime.warm-up-runs = 1 (configured)")
            .contains("datum.runtime.diagnostics.trace = off (default)")
            .contains("engine: " + TestRuntime.class.getName() + " test (jffi): A scripted test runtime.")
            .contains("program sandbox: sha256 " + sha + ", ABI 2.14.0")
            .contains("program pdf: sha256 ").contains("ABI 4.0.0")
            .contains("trace: off").contains("capture: off");
    }

    @Test
    void noReportIsLoggedWhenItIsSwitchedOff() {
        sandbox(settings().report(false).build()).start();
        assertThat(order).noneMatch(entry -> entry.startsWith("report:"));
    }

    @Test
    void explainShowsTheInputsTheApplicationSuppliedAsReplacedAndTheSlotCounts() {
        SandboxSettings settings = SandboxSettings.builder().build();
        DatumSandbox replaced = sandbox(settings, builder -> builder
            .limits(ProgramLimits.builder().validationSeconds(9L).build())
            .hostOptions(new HostOptions("warn", null, "Pacific/Chatham", Clock.systemUTC())));
        Map<String, Entry> entries = new java.util.LinkedHashMap<>();
        replaced.explain().entries().forEach(entry -> entries.put(entry.key(), entry));
        assertThat(entries.get("datum.runtime.engine")).satisfies(entry -> {
            assertThat(entry.source()).isEqualTo(Source.REPLACED);
            assertThat(entry.value()).isEqualTo(TestRuntime.class.getName());
        });
        assertThat(entries.get("datum.runtime.stop-grace").source()).as("a supplied runtime's own").isEqualTo(Source.REPLACED);
        assertThat(entries.get("datum.runtime.validation.time-limit")).satisfies(entry -> {
            assertThat(entry.source()).isEqualTo(Source.REPLACED);
            assertThat(entry.value()).isEqualTo(Duration.ofSeconds(9));
        });
        assertThat(entries.get("datum.runtime.validation.memory").source()).as("the same value is no replacement").isEqualTo(Source.DEFAULT);
        assertThat(entries.get("datum.host.formula-errors")).satisfies(entry -> assertThat(entry.value()).isEqualTo("warn"))
            .satisfies(entry -> assertThat(entry.source()).isEqualTo(Source.REPLACED));
        // A zone other than the JVM's, so it differs from what the settings (no zone: the JVM's) give.
        assertThat(entries.get("datum.host.time-zone").value()).isEqualTo("Pacific/Chatham");
        assertThat(entries.get("datum.runtime.validation.concurrency")).satisfies(entry -> {
            assertThat(entry.value()).as("the setting stays a number").isEqualTo(0);
            assertThat(entry.resolved()).isEqualTo(new com.argusvane.datum.sandbox.diagnostics.SettingsReport.Resolved("one per CPU", ProgramLimits.cpus()));
        });
        assertThat(entries.get("datum.runtime.pdf.concurrency").resolved().count()).isEqualTo(Math.min(2, ProgramLimits.cpus()));
        assertThat(replaced.explain().toString()).contains("datum.runtime.validation.concurrency = 0 (one per CPU = " + ProgramLimits.cpus() + ")")
            .contains("datum.runtime.pdf.concurrency = 0 (min(2, CPUs) = " + Math.min(2, ProgramLimits.cpus()) + ")");
        assertThat(replaced.explain().toString()).contains("datum.runtime.validation.time-limit = PT9S (replaced by the application's own input)");
        assertThat(settings.explain().entries()).as("the settings' own report is unchanged").noneMatch(entry -> entry.source() == Source.REPLACED);
    }

    @Test
    void aBindingsOwnRuntimeIsReplacedOnlyWhereItDiffers() {
        SandboxSettings settings = SandboxSettings.builder().engine(TestRuntime.class.getName()).build();
        DatumSandbox same = sandbox(settings, builder -> builder.runtime(spy, settings.engine().engineSettings())
            .limits(settings.limits(null)).hostOptions(settings.host().hostOptions(Clock.systemUTC())));
        assertThat(same.explain().entries()).as("inputs equal to the settings are no replacement").noneMatch(entry -> entry.source() == Source.REPLACED);
        same.close();

        DatumSandbox tuned = sandbox(settings, builder -> builder.runtime(spy, new EngineSettings(Duration.ofSeconds(9), 7)));
        assertThat(tuned.explain().get("datum.runtime.stop-grace")).satisfies(entry -> {
            assertThat(entry.source()).isEqualTo(Source.REPLACED);
            assertThat(entry.value()).isEqualTo(Duration.ofSeconds(9));
        });
        assertThat(tuned.explain().get("datum.runtime.max-strays").value()).isEqualTo(7);
        assertThat(tuned.explain().get("datum.runtime.engine").source()).as("its id is the configured one").isEqualTo(Source.CONFIGURED);
    }

    @Test
    void theReportOfARunningSandboxNamesItsProgramsAndItsReadHidesTheDirectory() throws Exception {
        Path directory = temp.resolve("read");
        DatumSandbox capturing = sandbox(settings().captureEnabled(true).captureDirectory(directory.toString()).trace("failures").build());
        assertThat(capturing.report().programs()).allSatisfy(line -> assertThat(line.unavailable()).contains("not read yet"));
        capturing.start();
        assertThat(capturing.report().programs()).extracting(line -> line.abi()).containsExactly("2.14.0", "4.0.0");
        assertThat(capturing.report().toString()).contains(directory.toString());
        assertThat(capturing.report().toJson(true).toString()).doesNotContain(directory.toString());
        assertThat(capturing.report().capture().enabled()).isTrue();
        assertThat(capturing.report().trace().mode()).isEqualTo("failures");
    }

    // ============================================================================================== failure containment and scrubbing

    private static long writerThreads() {
        return Thread.getAllStackTraces().keySet().stream().filter(t -> t.isAlive() && t.getName().startsWith("datum-sandbox-capture-")).count();
    }

    /** A RunTrace that throws an AssertionError leaves the start, a verdict and a failed run's answer as they are. */
    @Test
    void aTraceThatThrowsAnErrorChangesNoAnswer() {
        DatumSandbox asserting = sandbox(settings().trace("all").build(), builder -> builder.runTrace(record -> {
            throw new AssertionError("a host's trace bug");
        }));
        asserting.start();
        assertThat(asserting.status().isUp()).isTrue();
        assertThat(asserting.sandbox().validate(context("Ada"), List.of(), false).outcome().path("errors").isArray()).isTrue();
        engine.terminate = Termination.TRAP;
        assertThatThrownBy(() -> asserting.sandbox().validate(context("Ada"), List.of(), false)).isInstanceOfSatisfying(SandboxException.class,
            e -> assertThat(e.reason()).isEqualTo(SandboxException.Reason.TRAP));
    }

    /** An engine id in another case, or with blanks around it, is the engine it selects, not a replacement. */
    @Test
    void anEngineIdIsComparedAsTheEnginesAreSelected() {
        assertThat(SandboxSettings.builder().engine(" Endive ").build().engine().id()).isEqualTo("endive");
        assertThat(SandboxSettings.builder().engine(" Endive ").build().explain().get("datum.runtime.engine").source())
            .as("the default, written otherwise").isEqualTo(Source.DEFAULT);
        SandboxSettings shouted = SandboxSettings.builder().engine("  " + TestRuntime.class.getName().toUpperCase(java.util.Locale.ROOT) + " ").build();
        DatumSandbox same = sandbox(shouted, builder -> builder.runtime(spy, shouted.engine().engineSettings()));
        assertThat(same.explain().get("datum.runtime.engine").source()).isEqualTo(Source.CONFIGURED);
    }

    /** A sink whose describe() throws refuses nothing: the start, the report (the actuator's read) and the captures work. */
    @Test
    void aSinkWhoseDescribeThrowsBreaksNothing() throws Exception {
        long writers = writerThreads();
        List<RunCapture> written = Collections.synchronizedList(new ArrayList<>());
        RunCaptureSink broken = new RunCaptureSink() {
            @Override
            public long write(RunCapture capture) {
                written.add(capture);
                return capture.bytes();
            }

            @Override
            public void remove(String id) {
            }

            @Override
            public String describe() {
                throw new IllegalStateException("describe() is broken");
            }
        };
        DatumSandbox capturing = sandbox(settings().captureEnabled(true).build(), builder -> builder.captureSink(broken));
        capturing.start();
        assertThat(capturing.status().isUp()).isTrue();
        assertThat(capturing.report().toJson(true)).containsKey("capture");
        assertThat(capturing.report().toString()).contains("capture: on, into " + broken.getClass().getName());
        engine.terminate = Termination.TRAP;
        assertThatThrownBy(() -> capturing.sandbox().validate(context("Ada"), List.of(), false)).isInstanceOf(SandboxException.class);
        eventually(() -> written.size() == 1);
        assertThat(text(written.get(0).files().get("meta.json"))).contains(broken.getClass().getName());
        capturing.close();
        eventually(() -> writerThreads() == writers);
    }

    /** The trace is called after the run's slot is released, so a blocked trace sink holds no slot. */
    @Test
    void aTraceThatBlocksHoldsNoSlot() throws Exception {
        CountDownLatch entered = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        java.util.concurrent.atomic.AtomicBoolean blocking = new java.util.concurrent.atomic.AtomicBoolean();
        DatumSandbox traced = sandbox(settings().trace("all").validationConcurrency(1).validationWait(Duration.ZERO).build(),
            builder -> builder.runTrace(record -> {
                if (blocking.get() && "validate".equals(record.op())) {
                    entered.countDown();
                    try {
                        release.await();
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }
                }
            }));
        traced.start();
        blocking.set(true);
        Future<SandboxResult> first = callers.submit(() -> traced.sandbox().validate(context("Ada"), List.of(), false));
        assertThat(entered.await(5, TimeUnit.SECONDS)).isTrue();
        try (RunSlots.Permit second = traced.validationSlots().acquire()) {
            assertThat(traced.validationSlots().available()).as("the second run took the slot the first released").isZero();
        } finally {
            release.countDown();
        }
        assertThat(first.get(5, TimeUnit.SECONDS).outcome().path("errors").isArray()).isTrue();
    }

    /** A store whose programs a test switches between proofs, counting the reads of programs.json. */
    private static final class SwitchingStore {

        volatile Programs current = Programs.packaged();
        final AtomicInteger manifests = new AtomicInteger();

        ProgramStore store() {
            return new ProgramStore(name -> {
                if (name.endsWith("programs.json")) {
                    manifests.incrementAndGet();
                }
                return current.lookup().apply(name);
            }, null, null);
        }

        static Programs version(String sandboxAbi, String sandboxText) {
            Programs programs = new Programs();
            programs.put("datum-sandbox-program.js", sandboxText);
            programs.put("datum-pdf-program.js", Programs.PDF);
            programs.put("freeze-intrinsics.js", Programs.FREEZE);
            programs.manifest(sandboxAbi, sandboxText, Programs.PDF, Programs.FREEZE);
            return programs;
        }
    }

    /**
     * A recheck that loads new programs publishes them only once their proof passed, and each service's trace names the
     * ABI of the programs it was built over, whatever a later proof loaded.
     */
    @Test
    void aRecheckToNewProgramsLeavesEachServiceItsOwnAbiAndPublishesOnlyAProof() {
        SwitchingStore programs = new SwitchingStore();
        DatumSandbox traced = sandbox(settings().trace("all").failFast(false).build(), builder -> builder.store(programs.store()));
        traced.start();
        com.argusvane.datum.sandbox.protocol.Sandbox before = traced.sandbox();
        String firstSha = traced.report().programs().get(0).sha256();

        programs.current = SwitchingStore.version("2.15.0", "/* sandbox program, the next one */");
        traced.recheck();
        assertThat(traced.status().isUp()).isTrue();
        lines.clear();
        before.validate(context("Ada"), List.of(), false);
        traced.sandbox().validate(context("Ada"), List.of(), false);
        assertThat(lines).extracting(line -> field(line, "abi")).as("each service's own programs").containsExactly("2.14.0", "2.15.0");
        String secondSha = traced.report().programs().get(0).sha256();
        assertThat(secondSha).isNotEqualTo(firstSha);

        programs.current = SwitchingStore.version("2.16.0", "/* a stale sandbox program */");
        engine.sandboxProbeFails = true;
        traced.recheck();
        assertThat(traced.status().isUp()).isFalse();
        assertThat(traced.report().programs().get(0)).as("the failed proof's programs are not published").satisfies(line -> {
            assertThat(line.sha256()).isEqualTo(secondSha);
            assertThat(line.abi()).isEqualTo("2.15.0");
        });
    }

    /** A start reads the programs once, and the report names the ones it proved. */
    @Test
    void aStartReadsTheProgramsOnce() {
        SwitchingStore programs = new SwitchingStore();
        DatumSandbox reported = sandbox(settings().build(), builder -> builder.store(programs.store()));
        reported.start();
        assertThat(programs.manifests).as("the report and the proof share one read").hasValue(1);
        String sha = Programs.packaged().store().load().sandbox().sha256();
        assertThat(order.get(0)).contains("program sandbox: sha256 " + sha);
        assertThat(reported.report().programs().get(0).sha256()).isEqualTo(sha);
        reported.close();

        SwitchingStore quiet = new SwitchingStore();
        sandbox(settings().report(false).build(), builder -> builder.store(quiet.store())).start();
        assertThat(quiet.manifests).hasValue(1);
    }

    /**
     * One deadline. The runs get the shutdown grace; the capture drains in what is left of it and drops the rest
     * (counted), so with a run that holds the whole grace the stop takes about the grace, not twice it.
     */
    @Test
    void aStopKeepsOneDeadlineForTheRunsAndTheCapture() throws Exception {
        CountDownLatch gate = new CountDownLatch(1);
        CountDownLatch writing = new CountDownLatch(1);
        RunCaptureSink slow = new RunCaptureSink() {
            @Override
            public long write(RunCapture capture) throws IOException {
                writing.countDown();
                try {
                    gate.await();
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    throw new java.io.InterruptedIOException();
                }
                return capture.bytes();
            }

            @Override
            public void remove(String id) {
            }
        };
        Duration grace = Duration.ofSeconds(2);
        DatumSandbox capturing = sandbox(TestSettings.builder("endive", true, 1, grace, 1, Duration.ZERO).captureEnabled(true).build(),
            builder -> builder.captureSink(slow));
        capturing.start();
        engine.terminate = Termination.TRAP;
        for (int i = 0; i < 2; i++) {
            assertThatThrownBy(() -> capturing.sandbox().validate(context("Ada"), List.of(), false)).isInstanceOf(SandboxException.class);
        }
        assertThat(writing.await(5, TimeUnit.SECONDS)).isTrue();
        engine.terminate = null;
        engine.hold = new CountDownLatch(1);
        engine.holding = new CountDownLatch(1);
        Future<SandboxResult> held = callers.submit(() -> capturing.sandbox().validate(context("Ada"), List.of(), false));
        assertThat(engine.holding.await(5, TimeUnit.SECONDS)).isTrue();
        long started = System.nanoTime();
        capturing.stop();
        long took = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started);
        assertThat(took).as("the grace, then no second grace for the capture").isBetween(grace.toMillis() - 100, grace.toMillis() + 1_000);
        assertThat(capturing.captureCounts().dropped()).as("what was still queued").isGreaterThanOrEqualTo(1);
        assertThatThrownBy(() -> held.get(5, TimeUnit.SECONDS)).hasCauseInstanceOf(SandboxException.class);
        gate.countDown();
    }

    /** A stale PDF program's capabilities answer is the program's refusal in the trace, not a verdict. */
    @Test
    void aStalePdfCapabilitiesAnswerIsTracedAsRefused() {
        engine.pdfAbi = "3.18.0";
        DatumSandbox traced = sandbox(settings().trace("all").failFast(false).build());
        traced.start();
        assertThat(traced.status().isUp()).as("a stale PDF program fails the start like the sandbox program").isFalse();
        assertThat(lines).anySatisfy(line -> {
            assertThat(field(line, "program") + ":" + field(line, "op")).isEqualTo("pdf:capabilities");
            assertThat(field(line, "outcome")).isEqualTo("refused");
        });
    }

    /** Engine notes and a sink's description with a URL's credentials or a token are scrubbed in the start log and meta.json. */
    @Test
    void notesAndDescriptionsAreScrubbedInTheStartLogAndTheCapture() throws Exception {
        GuestRuntime noted = new GuestRuntime() {
            @Override
            public RunOutput run(GuestRun run) {
                return spy.run(run);
            }

            @Override
            public EngineInfo engineInfo() {
                return new EngineInfo(TestRuntime.class.getName(), "test", "jffi", "fetched from https://ops:hunter2@mirror/lib?token=t0k");
            }
        };
        List<RunCapture> written = Collections.synchronizedList(new ArrayList<>());
        RunCaptureSink bucket = new RunCaptureSink() {
            @Override
            public long write(RunCapture capture) {
                written.add(capture);
                return capture.bytes();
            }

            @Override
            public void remove(String id) {
            }

            @Override
            public String describe() {
                return "the bucket https://key:secret@minio/captures?token=abc";
            }
        };
        DatumSandbox capturing = sandbox(settings().captureEnabled(true).build(), builder -> builder.runtime(noted).captureSink(bucket));
        capturing.start();
        String report = order.get(0);
        assertThat(report).contains("https://***@mirror/lib?token=***").contains("https://***@minio/captures?token=***")
            .doesNotContain("hunter2").doesNotContain("t0k").doesNotContain("secret").doesNotContain("token=abc");
        engine.terminate = Termination.TRAP;
        assertThatThrownBy(() -> capturing.sandbox().validate(context("Ada"), List.of(), false)).isInstanceOf(SandboxException.class);
        eventually(() -> written.size() == 1);
        String meta = text(written.get(0).files().get("meta.json"));
        assertThat(meta).contains("https://***@mirror/lib?token=***").doesNotContain("hunter2").doesNotContain("t0k")
            .doesNotContain("secret").doesNotContain("token=abc");
    }
}
