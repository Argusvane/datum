package com.argusvane.datum.sandbox.protocol;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.core.observation.DatumObservationNames;
import com.argusvane.datum.core.observation.DatumObservations;
import com.argusvane.datum.sandbox.observation.GuestRunObservations;
import com.argusvane.datum.core.observation.RecordingObservations;
import com.argusvane.datum.sandbox.wasi.RunOutput;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

/**
 * Datum's own observation of every guest run: one {@code datum.sandbox.run} per sandbox operation, the slot
 * wait of a validation inside it (a busy refusal is observed, which the runtime's {@code datum.runs} timer never sees), one
 * {@code datum.pdf.run} per PDF program call; nothing at all without observations.
 */
class GuestRunObservationsTest {

    private static final Program PROGRAM = Program.of(Program.Kind.SANDBOX, "/* program */".getBytes(StandardCharsets.UTF_8));
    private static final Program PDF = Program.of(Program.Kind.PDF, "/* pdf */".getBytes(StandardCharsets.UTF_8));

    private static ObjectNode context() throws StrictJson.NotJsonException {
        return (ObjectNode) StrictJson.decode("{\"formId\":\"f\",\"form\":{\"id\":\"root\",\"type\":\"form\",\"configuration\":{},"
            + "\"children\":{\"content\":[]}},\"values\":{},\"locale\":\"en\"}");
    }

    @Test
    void everySandboxOperationIsOneObservationWithItsOpOutcomeAndEngineMode() throws Exception {
        RecordingObservations recording = new RecordingObservations();
        RunSlots slots = new RunSlots(1, Duration.ZERO, "validation");
        SandboxService service = new SandboxService(FakeRuntime.answering("{\"errors\":[]}"), PROGRAM, new RunScript("/* f */"),
            ProgramLimits.defaults(), HostOptions.defaults(), slots, new AbiProbe(), RunLog.slf4j());
        Sandbox sandbox = GuestRunObservations.sandbox(recording.observations(), "panama").decorate(service);

        sandbox.proveAbi();
        sandbox.validate(context(), List.of(), false);
        Sandbox.Smoke smoke = sandbox.smoke();
        try (RunSlots.Permit held = slots.acquire()) {
            assertThatThrownBy(() -> sandbox.validate(context(), List.of(), false)).isInstanceOf(SandboxException.class);
        }

        List<RecordingObservations.Recorded> runs = recording.named(DatumObservationNames.SANDBOX_RUN);
        assertThat(runs).extracting(one -> one.low("op")).containsExactly("abi", "validate", "smoke", "validate");
        assertThat(runs).allSatisfy(one -> assertThat(one.low("engine.mode")).isEqualTo("panama"));
        assertThat(runs.get(1).low("outcome")).isEqualTo("ok");
        assertThat(runs.get(2).low("outcome")).as("a smoke that gave the wrong verdict").isEqualTo(smoke.ok() ? "ok" : "failed");
        assertThat(runs.get(3).low("outcome")).as("the slot wait is inside the observation").isEqualTo("busy");
        assertThat(runs.get(3).error()).isInstanceOf(SandboxException.class);
        assertThat(runs.get(0).contextualName()).isEqualTo("datum sandbox run abi");
    }

    @Test
    void everyPdfProgramCallIsOneObservationNamedByItsOp() {
        RecordingObservations recording = new RecordingObservations();
        FakeRuntime runtime = new FakeRuntime(call -> {
            String op = call.input().path("op").asString("");
            String text = "capabilities".equals(op)
                ? "{\"ok\":true,\"op\":\"capabilities\",\"abi\":\"" + PdfAbi.MIN + "\",\"kernelVersion\":\"0.1.0\"}"
                : "{\"ok\":true,\"op\":\"" + op + "\"}";
            return RunOutput.exited(0, (text + "\n").getBytes(StandardCharsets.UTF_8), null);
        });
        PdfKernel kernel = GuestRunObservations.pdfKernel(recording.observations(), "jffi")
            .decorate(new PdfProgram(runtime, PDF, ProgramLimits.defaults(), new AbiProbe()));
        kernel.capabilities();
        kernel.call(JsonNodeFactory.instance.objectNode().put("abi", PdfAbi.MIN).put("op", "document"));
        kernel.call(JsonNodeFactory.instance.objectNode().put("abi", PdfAbi.MIN).put("op", "not a word"));
        assertThat(recording.named(DatumObservationNames.PDF_RUN)).extracting(one -> one.low("op"))
            .containsExactly("capabilities", "document", "other");
        assertThat(recording.named(DatumObservationNames.PDF_RUN)).allSatisfy(one -> {
            assertThat(one.low("engine.mode")).isEqualTo("jffi");
            assertThat(one.low("outcome")).isEqualTo("ok");
        });
    }

    @Test
    void withoutObservationsNothingIsWrapped() {
        SandboxService service = new SandboxService(FakeRuntime.answering("{\"errors\":[]}"), PROGRAM, new RunScript("/* f */"),
            ProgramLimits.defaults(), HostOptions.defaults(), new RunSlots(1, Duration.ZERO, "validation"), new AbiProbe(), RunLog.slf4j());
        assertThat(GuestRunObservations.sandbox(DatumObservations.none(), "panama").decorate(service)).isSameAs(service);
        PdfProgram program = new PdfProgram(FakeRuntime.answering("{}"), PDF, ProgramLimits.defaults(), new AbiProbe());
        assertThat(GuestRunObservations.pdfKernel(DatumObservations.none(), "panama").decorate(program)).isSameAs(program);
    }
}
