package com.argusvane.datum.sandbox.protocol;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.core.ProgramUnavailableException;
import com.argusvane.datum.sandbox.protocol.SandboxException.Reason;
import com.argusvane.datum.sandbox.wasi.RunOutput;
import com.argusvane.datum.sandbox.wasi.Termination;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.function.Function;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

/** The PDF program's gate (capabilities, major-only plus the floor) and one call. */
class PdfProgramTest {

    private static final Program PDF = Program.of(Program.Kind.PDF, "/* pdf */".getBytes(StandardCharsets.UTF_8));

    private static FakeRuntime guest(String capabilities, Function<FakeRuntime.Call, String> answer) {
        return new FakeRuntime(call -> {
            String op = call.input().path("op").asString("");
            String text = "capabilities".equals(op) ? capabilities : answer.apply(call);
            return RunOutput.exited(0, (text + "\n").getBytes(StandardCharsets.UTF_8), null);
        });
    }

    private static String capabilities(String abi) {
        return "{\"ok\":true,\"op\":\"capabilities\",\"abi\":\"" + abi + "\",\"kernelVersion\":\"0.1.0\"}";
    }

    @Test
    void speaksIsMajorOnlyAboveTheFloor() {
        assertThat(PdfAbi.MIN).isEqualTo("1.0.0");
        assertThat(SandboxAbi.MIN).isEqualTo("1.0.0");
        assertThat(PdfAbi.speaks("1.0.0")).isTrue();
        assertThat(PdfAbi.speaks("1.1.4")).isTrue();
        assertThat(PdfAbi.speaks("0.18.0")).isFalse();
        assertThat(PdfAbi.speaks("2.0.0")).isFalse();
        assertThat(PdfAbi.speaks("0.99.0")).isFalse();
        assertThat(PdfAbi.speaks("1.0")).isFalse();
        assertThat(PdfAbi.speaks(null)).isFalse();
    }

    @Test
    void capabilitiesAreAskedOncePerProgram() {
        FakeRuntime runtime = guest(capabilities("1.0.2"), call -> "{\"ok\":true,\"op\":\"document\",\"bytes\":\"JVBERi0=\"}");
        AbiProbe probe = new AbiProbe();
        PdfProgram pdf = new PdfProgram(runtime, PDF, ProgramLimits.defaults(), probe, null);
        assertThat(pdf.capabilities()).satisfies(answer -> {
            assertThat(answer.abi()).isEqualTo("1.0.2");
            assertThat(answer.kernelVersion()).isEqualTo("0.1.0");
        });
        ObjectNode request = JsonNodeFactory.instance.objectNode().put("abi", PdfAbi.MIN).put("op", "document");
        assertThat(pdf.call(request).get("bytes").stringValue()).isEqualTo("JVBERi0=");
        assertThat(runtime.calls).hasSize(2);
        FakeRuntime.Call first = runtime.calls.get(0);
        assertThat(first.input().toString()).isEqualTo("{\"abi\":\"1.0.0\",\"op\":\"capabilities\"}");
        assertThat(first.nonce()).as("no nonce frame for the PDF program").isNull();
        assertThat(first.script()).isEqualTo(RunScript.PDF);
        assertThat(first.argv()).containsExactly("qjs", "--std", "-I", "/app/datum-pdf-program.js", "/app/run.js");
        assertThat(first.budget()).isEqualTo(ProgramLimits.defaults().pdfBudget());
        assertThat(probe.pdfCapabilities(PDF)).hasValueSatisfying(answer -> assertThat(answer.kernelVersion()).isEqualTo("0.1.0"));
    }

    @Test
    void aProgramOfAnotherMajorOrOlderThanTheFloorIsUnavailable() {
        for (String abi : new String[] {"2.0.0", "0.18.0", "0.99.0"}) {
            FakeRuntime runtime = guest(capabilities(abi), call -> "{\"ok\":true}");
            PdfProgram pdf = new PdfProgram(runtime, PDF, ProgramLimits.defaults(), new AbiProbe(), null);
            assertThatThrownBy(() -> pdf.call(JsonNodeFactory.instance.objectNode().put("op", "document")))
                .as(abi).isInstanceOf(ProgramUnavailableException.class).hasMessageContaining(abi);
            assertThat(runtime.calls).hasSize(1);
        }
        FakeRuntime refusing = guest("{\"ok\":false,\"error\":{\"code\":\"abi_mismatch\",\"message\":\"x\"}}", call -> "{}");
        assertThatThrownBy(() -> new PdfProgram(refusing, PDF, ProgramLimits.defaults(), new AbiProbe(), null).capabilities())
            .isInstanceOf(ProgramUnavailableException.class).hasMessageContaining("abi_mismatch");
        FakeRuntime unversioned = guest("{\"ok\":true,\"op\":\"capabilities\",\"abi\":\"1.0.0\"}", call -> "{}");
        assertThatThrownBy(() -> new PdfProgram(unversioned, PDF, ProgramLimits.defaults(), new AbiProbe(), null).capabilities())
            .as("the kernel's version is required").isInstanceOf(ProgramUnavailableException.class).hasMessageContaining("kernelVersion");
        FakeRuntime throwing = new FakeRuntime(call -> RunOutput.exited(1, null, "TypeError".getBytes(StandardCharsets.UTF_8)));
        assertThatThrownBy(() -> new PdfProgram(throwing, PDF, ProgramLimits.defaults(), new AbiProbe(), null).capabilities())
            .isInstanceOf(ProgramUnavailableException.class).hasMessageContaining("THREW");
    }

    @Test
    void aRefusalCarriesTheKernelsCodeAndBadAnswersAreRefused() {
        FakeRuntime runtime = guest(capabilities("1.0.0"), call -> "{\"ok\":false,\"error\":{\"code\":\"template\",\"message\":\"guest words\"}}");
        PdfProgram pdf = new PdfProgram(runtime, PDF, ProgramLimits.defaults(), new AbiProbe(), null);
        assertThatThrownBy(() -> pdf.call(JsonNodeFactory.instance.objectNode().put("op", "fill")))
            .isInstanceOfSatisfying(SandboxException.class, e -> {
                assertThat(e.reason()).isEqualTo(Reason.REFUSED);
                assertThat(e.programCode()).isEqualTo("template");
                assertThat(e.getMessage()).doesNotContain("guest words");
            });
        PdfProgram notJson = new PdfProgram(guest(capabilities("1.0.0"), call -> "%PDF-1.7"), PDF, ProgramLimits.defaults(), new AbiProbe(), null);
        assertThatThrownBy(() -> notJson.call(JsonNodeFactory.instance.objectNode()))
            .isInstanceOfSatisfying(SandboxException.class, e -> assertThat(e.reason()).isEqualTo(Reason.NOT_JSON));
        PdfProgram array = new PdfProgram(guest(capabilities("1.0.0"), call -> "[]"), PDF, ProgramLimits.defaults(), new AbiProbe(), null);
        assertThatThrownBy(() -> array.call(JsonNodeFactory.instance.objectNode()))
            .isInstanceOfSatisfying(SandboxException.class, e -> assertThat(e.reason()).isEqualTo(Reason.NO_OUTCOME));
    }

    /** A clock the test moves. */
    private static final class MovingClock extends Clock {

        private Instant now = Instant.parse("2026-10-15T12:00:00Z");

        void advance(Duration by) {
            now = now.plus(by);
        }

        @Override
        public ZoneId getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(ZoneId zone) {
            return this;
        }

        @Override
        public Instant instant() {
            return now;
        }
    }

    /** A failed capabilities answer is remembered for 60 s: a stale program costs no run per request. */
    @Test
    void aFailedCapabilitiesAnswerIsRememberedForAMinute() {
        MovingClock clock = new MovingClock();
        AbiProbe probe = new AbiProbe(clock);
        FakeRuntime stale = guest(capabilities("0.14.0"), call -> "{\"ok\":true}");
        PdfProgram pdf = new PdfProgram(stale, PDF, ProgramLimits.defaults(), probe, null);
        ObjectNode request = JsonNodeFactory.instance.objectNode().put("op", "document");
        assertThatThrownBy(() -> pdf.call(request)).isInstanceOf(ProgramUnavailableException.class).hasMessageContaining("0.14.0");
        assertThat(stale.calls).hasSize(1);
        // Within the minute: refused with the same words, and nothing runs.
        clock.advance(Duration.ofSeconds(59));
        assertThatThrownBy(() -> pdf.call(request)).isInstanceOfSatisfying(ProgramUnavailableException.class, e -> {
            assertThat(e.getMessage()).contains("0.14.0");
            assertThat(e.httpStatus()).isEqualTo(503);
        });
        assertThatThrownBy(pdf::capabilities).isInstanceOf(ProgramUnavailableException.class);
        assertThat(stale.calls).hasSize(1);
        // After it: asked again.
        clock.advance(Duration.ofSeconds(1));
        assertThatThrownBy(() -> pdf.call(request)).isInstanceOf(ProgramUnavailableException.class);
        assertThat(stale.calls).hasSize(2);

        // A run that failed (here: threw) is remembered too; another program file is not refused by it.
        FakeRuntime throwing = new FakeRuntime(call -> RunOutput.exited(1, null, null));
        PdfProgram failing = new PdfProgram(throwing, PDF, ProgramLimits.defaults(), probe, null);
        clock.advance(Duration.ofSeconds(61));
        assertThatThrownBy(failing::capabilities).isInstanceOf(ProgramUnavailableException.class).hasMessageContaining("THREW");
        assertThatThrownBy(failing::capabilities).isInstanceOf(ProgramUnavailableException.class).hasMessageContaining("THREW");
        assertThat(throwing.calls).hasSize(1);
        Program other = Program.of(Program.Kind.PDF, "/* other */".getBytes(StandardCharsets.UTF_8));
        FakeRuntime good = guest(capabilities("1.0.0"), call -> "{\"ok\":true}");
        assertThat(new PdfProgram(good, other, ProgramLimits.defaults(), probe, null).capabilities().abi()).isEqualTo("1.0.0");

        // A run the host cancelled says nothing about the program: not remembered.
        AbiProbe fresh = new AbiProbe(clock);
        FakeRuntime cancelled = new FakeRuntime(call -> new RunOutput(Termination.INTERRUPTED, 0, null, null, null));
        PdfProgram interrupted = new PdfProgram(cancelled, PDF, ProgramLimits.defaults(), fresh, null);
        assertThatThrownBy(interrupted::capabilities).isInstanceOf(ProgramUnavailableException.class);
        assertThatThrownBy(interrupted::capabilities).isInstanceOf(ProgramUnavailableException.class);
        assertThat(cancelled.calls).hasSize(2);
        assertThat(fresh.pdfFailure(PDF)).isEmpty();
        // A later good answer clears a remembered failure.
        FakeRuntime recovered = guest(capabilities("1.0.0"), call -> "{\"ok\":true}");
        fresh.rememberPdfFailure(PDF, "earlier");
        clock.advance(Duration.ofSeconds(60));
        assertThat(new PdfProgram(recovered, PDF, ProgramLimits.defaults(), fresh, null).capabilities().kernelVersion()).isEqualTo("0.1.0");
        assertThat(fresh.pdfFailure(PDF)).isEmpty();
    }

    @Test
    void theProgramMustBeThePdfOne() {
        assertThatThrownBy(() -> new PdfProgram(guest("{}", c -> "{}"), Program.of(Program.Kind.SANDBOX, new byte[] {1}), ProgramLimits.defaults(), new AbiProbe(), null))
            .isInstanceOf(IllegalArgumentException.class);
    }
}
