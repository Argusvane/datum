package com.argusvane.datum.sandbox.protocol;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowable;

import com.argusvane.datum.core.ProgramUnavailableException;
import com.argusvane.datum.sandbox.diagnostics.RunFacts;
import com.argusvane.datum.sandbox.wasi.RunOutput;
import com.argusvane.datum.sandbox.wasi.Termination;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Function;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.node.ObjectNode;

/**
 * What the protocol tells a recorder of each run: the outcome words, which of them are failed runs, the
 * operation words, and that the checks and their answers are the same with a recorder as without one.
 */
class RunWatchTest {

    private static final Program PROGRAM = Program.of(Program.Kind.SANDBOX, "/* program */".getBytes(StandardCharsets.UTF_8));
    private static final Program PDF = Program.of(Program.Kind.PDF, "/* pdf */".getBytes(StandardCharsets.UTF_8));
    private static final RunScript SCRIPTS = new RunScript("/* freeze */");

    private final List<RunFacts> facts = new ArrayList<>();

    private SandboxService service(FakeRuntime runtime, boolean recorded) {
        return new SandboxService(runtime, PROGRAM, SCRIPTS, ProgramLimits.defaults(), new HostOptions(null, null, "UTC", Clock.systemUTC()),
            new RunSlots(2, Duration.ZERO, "validation"), new AbiProbe(), RunLog.slf4j(), recorded ? facts::add : null);
    }

    private static ObjectNode context() {
        try {
            return (ObjectNode) StrictJson.decode("{\"formId\":\"f\",\"form\":{\"id\":\"root\",\"type\":\"form\",\"configuration\":{},"
                + "\"children\":{\"content\":[]}},\"values\":{\"name\":\"Ada\"},\"locale\":\"en\"}");
        } catch (StrictJson.NotJsonException e) {
            throw new AssertionError(e);
        }
    }

    /** A guest whose probe passes and whose validation ends as {@code work} says. */
    private static FakeRuntime guest(Function<FakeRuntime.Call, RunOutput> work) {
        return new FakeRuntime(call -> FakeRuntime.isProbe(call) ? call.framed(FakeRuntime.PROBE_OK) : work.apply(call));
    }

    /** The outcome word of one validation, and that the answer is what the service gives without a recorder. */
    private String outcomeOf(Function<FakeRuntime.Call, RunOutput> work) {
        facts.clear();
        Throwable with = catchThrowable(() -> service(guest(work), true).validate(context(), List.of(), false));
        Throwable without = catchThrowable(() -> service(guest(work), false).validate(context(), List.of(), false));
        assertThat(with == null ? null : with.getClass()).isEqualTo(without == null ? null : without.getClass());
        assertThat(with == null ? null : with.getMessage()).isEqualTo(without == null ? null : without.getMessage());
        assertThat(facts).as("the probe, then the validation").hasSize(2);
        assertThat(facts.get(0).op()).isEqualTo("abi");
        assertThat(facts.get(0).outcome()).isEqualTo("verdict");
        RunFacts validation = facts.get(1);
        assertThat(validation.op()).isEqualTo("validate");
        assertThat(validation.failed()).isEqualTo(!"verdict".equals(validation.outcome()));
        return validation.outcome();
    }

    @Test
    void theProtocolsRefusalsOfAnAnswerAreFailedRunsAndAVerdictIsNot() {
        assertThat(outcomeOf(call -> call.framed("{\"errors\":[]}"))).isEqualTo("verdict");
        assertThat(outcomeOf(call -> call.framed("{\"errors\":[{\"code\":\"required\",\"componentId\":\"name\"}]}")))
            .as("a validation that rejects the answers is a verdict").isEqualTo("verdict");
        assertThat(outcomeOf(call -> RunOutput.exited(0, "no frame at all\n".getBytes(StandardCharsets.UTF_8), null))).isEqualTo("no_outcome");
        assertThat(outcomeOf(call -> RunOutput.exited(0, Fixtures.frame("ffffffffffffffffffffffffffffffff", "{\"errors\":[]}")
            .getBytes(StandardCharsets.UTF_8), null))).as("another run's nonce").isEqualTo("no_outcome");
        assertThat(outcomeOf(call -> RunOutput.exited(0, ("stray\n" + Fixtures.frame(call.nonce(), "{\"errors\":[]}"))
            .getBytes(StandardCharsets.UTF_8), null))).as("stray output").isEqualTo("frame");
        assertThat(outcomeOf(call -> call.framed("not json"))).isEqualTo("not_json");
        assertThat(outcomeOf(call -> call.framed("{\"no\":\"errors\"}"))).isEqualTo("no_outcome");
        assertThat(outcomeOf(call -> new RunOutput(Termination.TRAP, -1, null, null, "unreachable"))).isEqualTo("trap");
        assertThat(outcomeOf(call -> new RunOutput(Termination.OUTPUT_CAP, -1, null, null, null))).isEqualTo("output_cap");
        assertThat(outcomeOf(call -> new RunOutput(Termination.BUDGET, -1, null, null, null))).isEqualTo("budget");
        assertThat(outcomeOf(call -> new RunOutput(Termination.STUCK, -1, null, null, null))).as("the answer's word; the trace keeps stuck")
            .isEqualTo("budget");
        assertThat(outcomeOf(call -> new RunOutput(Termination.INTERRUPTED, -1, null, null, "host out of heap"))).isEqualTo("interrupted");
        assertThat(outcomeOf(call -> RunOutput.exited(1, null, "Error: thrown".getBytes(StandardCharsets.UTF_8)))).isEqualTo("threw");
        assertThat(outcomeOf(call -> {
            throw new ProgramUnavailableException("The runtime is refusing runs: 2 stopped runs have not ended yet.");
        })).as("the stray bound").isEqualTo("unavailable");
        assertThat(outcomeOf(call -> null)).isEqualTo("unavailable");
    }

    @Test
    void theRecordedFactsCarryTheRunsInputAndOutput() {
        RunOutput[] out = new RunOutput[1];
        SandboxService service = service(guest(call -> out[0] = call.framed("{\"errors\":[]}")), true);
        service.validate(context(), List.of(), false);
        RunFacts validation = facts.get(1);
        assertThat(validation.program()).isEqualTo("sandbox");
        assertThat(validation.sha256()).isEqualTo(PROGRAM.sha256());
        assertThat(validation.output()).isSameAs(out[0]);
        java.nio.ByteBuffer stdin = validation.stdin();
        byte[] bytes = new byte[stdin.remaining()];
        stdin.get(bytes);
        assertThat(new String(bytes, StandardCharsets.UTF_8)).contains("\"Ada\"");
        assertThat(validation.runScript()).contains("__datum_run");
        assertThat(validation.totalNanos()).isPositive();
    }

    @Test
    void anInspectRefusalIsTheProgramsAnswerAndOpsAreTheHostsWords() {
        SandboxService service = service(guest(call -> call.framed("{\"ok\":false,\"error\":{\"code\":\"bad\"}}")), true);
        catchThrowable(() -> service.inspect("check", context()));
        assertThat(facts.get(facts.size() - 1).op()).isEqualTo("check");
        assertThat(facts.get(facts.size() - 1).outcome()).isEqualTo("refused");
        assertThat(facts.get(facts.size() - 1).failed()).isFalse();
        assertThat(RunWatch.op("../../etc/passwd")).isEqualTo("other");
        assertThat(RunWatch.op("render")).isEqualTo("render");
        assertThat(RunWatch.op("x".repeat(40))).isEqualTo("other");
        assertThat(RunWatch.op(null)).isEqualTo("other");
        assertThat(RunWatch.probeOutcome("{\"ok\":false}".getBytes(StandardCharsets.UTF_8))).isEqualTo("refused");
        assertThat(RunWatch.probeOutcome("nope".getBytes(StandardCharsets.UTF_8))).isEqualTo("not_json");
    }

    @Test
    void aRecorderThatThrowsNeverChangesTheAnswer() {
        SandboxService service = new SandboxService(guest(call -> call.framed("{\"errors\":[]}")), PROGRAM, SCRIPTS, ProgramLimits.defaults(),
            HostOptions.defaults(), new RunSlots(1, Duration.ZERO, "validation"), new AbiProbe(), RunLog.slf4j(), run -> {
                throw new IllegalStateException("recorder down");
            });
        assertThat(service.validate(context(), List.of(), false).outcome().path("errors").isArray()).isTrue();
    }

    /** An Error from the recorder (an AssertionError of a host's trace) never replaces the answer; a broken JVM's does. */
    @Test
    void anErrorFromTheRecorderNeverChangesTheAnswerButABrokenJvmGoesOn() {
        FakeRuntime trapping = guest(call -> new RunOutput(Termination.TRAP, -1, null, null, "unreachable"));
        SandboxService asserting = new SandboxService(trapping, PROGRAM, SCRIPTS, ProgramLimits.defaults(), HostOptions.defaults(),
            new RunSlots(1, Duration.ZERO, "validation"), new AbiProbe(), RunLog.slf4j(), run -> {
                throw new AssertionError("a host's trace bug");
            });
        assertThat(catchThrowable(() -> asserting.validate(context(), List.of(), false)))
            .isInstanceOfSatisfying(SandboxException.class, e -> assertThat(e.reason()).isEqualTo(SandboxException.Reason.TRAP));
        SandboxService outOfHeap = new SandboxService(guest(call -> call.framed("{\"errors\":[]}")), PROGRAM, SCRIPTS, ProgramLimits.defaults(),
            HostOptions.defaults(), new RunSlots(1, Duration.ZERO, "validation"), new AbiProbe(), RunLog.slf4j(), run -> {
                throw new OutOfMemoryError("building the record");
            });
        assertThat(outOfHeap.validate(context(), List.of(), false).outcome().path("errors").isArray()).isTrue();
        SandboxService broken = new SandboxService(guest(call -> call.framed("{\"errors\":[]}")), PROGRAM, SCRIPTS, ProgramLimits.defaults(),
            HostOptions.defaults(), new RunSlots(1, Duration.ZERO, "validation"), new AbiProbe(), RunLog.slf4j(), run -> {
                throw new InternalError("the JVM is broken");
            });
        assertThat(catchThrowable(() -> broken.validate(context(), List.of(), false))).isInstanceOf(InternalError.class);
    }

    /** With no recorder a watch is never made, and a service built without one holds none. */
    @Test
    void withoutARecorderNoWatchIsMadeAndTheServicesHoldNone() {
        assertThat(RunWatch.start(null, PROGRAM, "validate", "run.js", new byte[1])).isNull();
        assertThat(RunWatch.start(facts::add, PROGRAM, "validate", "run.js", new byte[1])).isNotNull();
        assertThat(service(FakeRuntime.answering("{}"), false).recorder()).isNull();
        assertThat(service(FakeRuntime.answering("{}"), true).recorder()).isNotNull();
        assertThat(new PdfProgram((program, script, argv, stdin, budget) -> null, PDF, ProgramLimits.defaults(), new AbiProbe()).recorder()).isNull();
    }

    /** A check whose answer lists no structure, or a public copy with no definition, is the run's no_outcome. */
    @Test
    void theLastCheckOfACheckOrAPublicCopyIsTheRunsOutcome() {
        SandboxService noStructure = service(FakeRuntime.answering("{\"ok\":true,\"op\":\"check\",\"problems\":[]}"), true);
        facts.clear();
        assertThat(catchThrowable(() -> noStructure.check(DefinitionDepthTest.nested(3), List.of(), List.of())))
            .isInstanceOf(ProgramUnavailableException.class).hasMessageContaining("NO_OUTCOME");
        assertThat(facts).extracting(RunFacts::op).containsExactly("abi", "check");
        assertThat(facts.get(1).outcome()).isEqualTo("no_outcome");
        assertThat(facts.get(1).failed()).isTrue();

        ObjectNode secret = DefinitionDepthTest.nested(3);
        secret.set("rules", tools.jackson.databind.node.JsonNodeFactory.instance.arrayNode()
            .add(tools.jackson.databind.node.JsonNodeFactory.instance.objectNode().put("scope", "server-secret")));
        SandboxService noDefinition = service(FakeRuntime.answering("{\"ok\":true,\"op\":\"public\"}"), true);
        facts.clear();
        assertThat(catchThrowable(() -> noDefinition.publicCopy(secret))).isInstanceOfSatisfying(SandboxException.class,
            e -> assertThat(e.reason()).isEqualTo(SandboxException.Reason.NO_OUTCOME));
        assertThat(facts.get(facts.size() - 1).op()).isEqualTo("public");
        assertThat(facts.get(facts.size() - 1).outcome()).isEqualTo("no_outcome");

        SandboxService whole = service(FakeRuntime.answering("{\"ok\":true,\"op\":\"check\",\"problems\":[],\"structure\":[],"
            + "\"structureWarnings\":[]}"), true);
        facts.clear();
        whole.check(DefinitionDepthTest.nested(3), List.of(), List.of());
        assertThat(facts.get(1).outcome()).isEqualTo("verdict");
    }

    private static ProgramRunner pdfGuest(String capabilities, String answer) {
        return (program, script, argv, stdin, budget) -> RunOutput.exited(0, (new String(stdin, StandardCharsets.UTF_8).contains("capabilities")
            ? capabilities : answer).getBytes(StandardCharsets.UTF_8), null);
    }

    private static ObjectNode render() {
        ObjectNode request = tools.jackson.databind.node.JsonNodeFactory.instance.objectNode();
        request.put("abi", PdfAbi.MIN);
        request.put("op", "render");
        return request;
    }

    /**
     * A PDF answer whose ok is not a boolean is no outcome (a failed run), ok false is the program's refusal,
     * and a capabilities answer the gate refuses (a stale ABI) is refused, not a verdict; the callers' answers are unchanged.
     */
    @Test
    void aPdfAnswerIsJudgedByItsOkAndAStaleCapabilitiesAnswerIsRefused() {
        String fresh = "{\"ok\":true,\"op\":\"capabilities\",\"abi\":\"" + PdfAbi.MIN + "\",\"kernelVersion\":\"0.1.0\"}";
        for (String noOk : List.of("{}", "{\"error\":{\"code\":\"x\",\"message\":\"m\"}}", "{\"ok\":\"true\"}")) {
            facts.clear();
            PdfProgram program = new PdfProgram(pdfGuest(fresh, noOk), PDF, ProgramLimits.defaults(), new AbiProbe(), facts::add);
            assertThat(catchThrowable(() -> program.call(render()))).as(noOk).isInstanceOfSatisfying(SandboxException.class,
                e -> assertThat(e.reason()).as("the caller's answer is unchanged").isEqualTo(SandboxException.Reason.REFUSED));
            assertThat(facts.get(1).outcome()).as(noOk).isEqualTo("no_outcome");
            assertThat(facts.get(1).failed()).isTrue();
        }
        facts.clear();
        PdfProgram refusing = new PdfProgram(pdfGuest(fresh, "{\"ok\":false,\"error\":{\"code\":\"x\"}}"), PDF, ProgramLimits.defaults(),
            new AbiProbe(), facts::add);
        catchThrowable(() -> refusing.call(render()));
        assertThat(facts.get(1).outcome()).isEqualTo("refused");

        for (String stale : List.of("{\"ok\":true,\"op\":\"capabilities\",\"abi\":\"0.18.0\",\"kernelVersion\":\"0.1.0\"}",
            "{\"ok\":true,\"op\":\"capabilities\",\"abi\":\"" + PdfAbi.MIN + "\"}", "{\"ok\":false,\"error\":{\"code\":\"abi_mismatch\"}}")) {
            facts.clear();
            PdfProgram old = new PdfProgram(pdfGuest(stale, "{}"), PDF, ProgramLimits.defaults(), new AbiProbe(), facts::add);
            assertThat(catchThrowable(old::capabilities)).isInstanceOf(ProgramUnavailableException.class);
            assertThat(facts).singleElement().satisfies(run -> {
                assertThat(run.op()).isEqualTo("capabilities");
                assertThat(run.outcome()).as(stale).isEqualTo("refused");
                assertThat(run.failed()).isFalse();
            });
        }
        facts.clear();
        PdfProgram noOk = new PdfProgram(pdfGuest("{\"op\":\"capabilities\"}", "{}"), PDF, ProgramLimits.defaults(), new AbiProbe(), facts::add);
        assertThat(catchThrowable(noOk::capabilities)).isInstanceOf(ProgramUnavailableException.class);
        assertThat(facts.get(0).outcome()).isEqualTo("no_outcome");
        facts.clear();
        new PdfProgram(pdfGuest(fresh, "{}"), PDF, ProgramLimits.defaults(), new AbiProbe(), facts::add).capabilities();
        assertThat(facts.get(0).outcome()).isEqualTo("verdict");
    }

    @Test
    void aPdfRunIsRecordedWithItsOpAndARefusalIsNotAFailure() {
        ProgramRunner pdf = (program, script, argv, stdin, budget) -> {
            String request = new String(stdin, StandardCharsets.UTF_8);
            String answer = request.contains("capabilities") ? "{\"ok\":true,\"op\":\"capabilities\",\"abi\":\"" + PdfAbi.MIN + "\",\"kernelVersion\":\"0.1.0\"}"
                : "{\"ok\":false,\"error\":{\"code\":\"template.invalid\"}}";
            return RunOutput.exited(0, answer.getBytes(StandardCharsets.UTF_8), null);
        };
        PdfProgram program = new PdfProgram(pdf, PDF, ProgramLimits.defaults(), new AbiProbe(), facts::add);
        ObjectNode request = tools.jackson.databind.node.JsonNodeFactory.instance.objectNode();
        request.put("abi", PdfAbi.MIN);
        request.put("op", "render");
        catchThrowable(() -> program.call(request));
        assertThat(facts).extracting(RunFacts::op).containsExactly("capabilities", "render");
        assertThat(facts).extracting(RunFacts::program).containsOnly("pdf");
        assertThat(facts.get(1).outcome()).isEqualTo("refused");
        assertThat(facts.get(1).failed()).isFalse();
    }
}
