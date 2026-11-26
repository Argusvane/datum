package com.argusvane.datum.sandbox.protocol;

import static com.argusvane.datum.sandbox.protocol.Fixtures.NONCE;
import static com.argusvane.datum.sandbox.protocol.Fixtures.started;
import static com.argusvane.datum.sandbox.protocol.Fixtures.utf8;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.core.ProgramUnavailableException;
import com.argusvane.datum.sandbox.protocol.SandboxException.Reason;
import com.argusvane.datum.sandbox.wasi.Budget;
import com.argusvane.datum.sandbox.wasi.RunOutput;
import com.argusvane.datum.sandbox.wasi.Termination;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

/**
 * How a finished run is read: guest words on stderr never make the runtime unavailable, the
 * budget labels, and the termination table a runtime reports structurally.
 */
class RunClassifierTest {

    private static final Budget BUDGET = new Budget(5, 32L * 1024 * 1024, Budget.STDOUT_LIMIT, Budget.STDERR_LIMIT);

    private static SandboxException sandboxFailure(RunOutput output) {
        try {
            RunClassifier.sandboxAnswer(output, NONCE, BUDGET);
        } catch (SandboxException e) {
            return e;
        }
        throw new AssertionError("The run was read as an answer.");
    }

    /** Words on stderr the guest wrote do not decide "unavailable". */
    @Test
    void guestWordsOnStderrDoNotMakeTheRuntimeUnavailable() {
        String startedLine = started() + "\n";
        // The guest ran (started) and threw a message holding the old tripwires.
        for (String stderr : new String[] {"Error: No such file attacker", "Error: failed deserialization", "No such file"}) {
            SandboxException e = sandboxFailure(RunOutput.exited(1, utf8(startedLine), utf8(stderr)));
            assertThat(e.reason()).as(stderr).isEqualTo(Reason.THREW);
            assertThat(e.code()).isEqualTo("wasm.execution_error");
        }
        // Before the guest's first line stderr is the runtime's own.
        assertThatThrownBy(() -> RunClassifier.sandboxAnswer(
            RunOutput.exited(1, utf8(""), utf8("Error: failed to read input file: No such file or directory")), NONCE, BUDGET))
            .isInstanceOf(ProgramUnavailableException.class);
        assertThatThrownBy(() -> RunClassifier.sandboxAnswer(RunOutput.exited(127, utf8(""), utf8("")), NONCE, BUDGET))
            .isInstanceOf(ProgramUnavailableException.class);
        // Exit 127 after the guest started is the guest's exit, not a missing runtime.
        assertThat(sandboxFailure(RunOutput.exited(127, utf8(startedLine), utf8(""))).reason()).isEqualTo(Reason.THREW);
        // No precompiled module here: "failed deserialization" is nothing to retry, and not a start failure.
        assertThat(sandboxFailure(RunOutput.exited(1, utf8(""), utf8("failed deserialization of the module"))).reason())
            .isEqualTo(Reason.THREW);
    }

    /** The budget words stay as labels, and a stop is the guest's own only after it started. */
    @ParameterizedTest
    @CsvSource(delimiter = '|', value = {
        "134 | Caused by: wasm trap: interrupt | BUDGET",
        "1   | InternalError: out of memory    | MEMORY",
        "134 | memory size exceeded            | MEMORY",
    })
    void budgetLabels(int exit, String stderr, Reason reason) {
        SandboxException after = sandboxFailure(RunOutput.exited(exit, utf8(started() + "\n"), utf8(stderr)));
        assertThat(after.reason()).isEqualTo(reason);
        assertThat(after.guestStopped()).isTrue();
        assertThat(after.code()).isEqualTo("wasm.execution_error");
        SandboxException before = sandboxFailure(RunOutput.exited(exit, utf8(""), utf8(stderr)));
        assertThat(before.reason()).isEqualTo(reason);
        assertThat(before.guestStopped()).isFalse();
    }

    @Test
    void aThrownErrorKeepsItsStderrForTheLogOnly() {
        SandboxException e = sandboxFailure(RunOutput.exited(1, utf8(started() + "\n"), utf8("Error: boom\n")));
        assertThat(e.reason()).isEqualTo(Reason.THREW);
        assertThat(e.stderr()).isEqualTo("Error: boom");
        assertThat(e.getMessage()).doesNotContain("boom");
    }

    /** What the runtime reports structurally, its own stops first: a stopped run is never an answer. */
    @Test
    void terminationTable() {
        byte[] startedOut = utf8(started() + "\n");
        // The output cap: never the guest's stop, whatever stdout holds.
        SandboxException cap = sandboxFailure(new RunOutput(Termination.OUTPUT_CAP, 0, utf8(Fixtures.frame(NONCE, "{\"errors\":[]}")), null, null));
        assertThat(cap.reason()).isEqualTo(Reason.OUTPUT_CAP);
        assertThat(cap.guestStopped()).isFalse();
        assertThat(cap.getMessage()).contains("output limit");
        // The time budget: the guest's own once it had started.
        assertThat(sandboxFailure(new RunOutput(Termination.BUDGET, 0, startedOut, null, null)).guestStopped()).isTrue();
        assertThat(sandboxFailure(new RunOutput(Termination.BUDGET, 0, null, null, null)).guestStopped()).isFalse();
        assertThat(sandboxFailure(new RunOutput(Termination.BUDGET, 0, null, null, null)).getMessage()).contains("5 s budget");
        // Memory likewise.
        SandboxException memory = sandboxFailure(new RunOutput(Termination.MEMORY, 0, startedOut, null, null));
        assertThat(memory.reason()).isEqualTo(Reason.MEMORY);
        assertThat(memory.guestStopped()).isTrue();
        assertThat(sandboxFailure(new RunOutput(Termination.MEMORY, 0, null, null, null)).guestStopped()).isFalse();
        // A trap, the guest's or the program's: a failed run, never a limit.
        SandboxException trap = sandboxFailure(new RunOutput(Termination.TRAP, 0, startedOut, null, "unreachable"));
        assertThat(trap.reason()).isEqualTo(Reason.TRAP);
        assertThat(trap.guestStopped()).isFalse();
        // Past the host's backstop and still going after its cancel: a budget stop for its caller, as an ordinary
        // timeout, but never the guest's own, whatever stdout holds.
        SandboxException stuck = sandboxFailure(new RunOutput(Termination.STUCK, -1, startedOut, null, null));
        assertThat(stuck.reason()).isEqualTo(Reason.BUDGET);
        assertThat(stuck.code()).isEqualTo("wasm.execution_error");
        assertThat(stuck.httpStatus()).isEqualTo(503);
        assertThat(stuck.guestStopped()).isFalse();
        assertThat(stuck.getMessage()).isEqualTo("The sandbox run passed its 5 s budget and did not stop.");
        assertThat(sandboxFailure(new RunOutput(Termination.STUCK, -1, utf8(Fixtures.frame(NONCE, "{\"errors\":[]}")), null, null))
            .reason()).as("never an answer").isEqualTo(Reason.BUDGET);
        // Cancelled by the host: nothing was judged.
        SandboxException cancelled = sandboxFailure(new RunOutput(Termination.INTERRUPTED, 0, startedOut, null, null));
        assertThat(cancelled.reason()).isEqualTo(Reason.INTERRUPTED);
        assertThat(cancelled.code()).isEqualTo("server.unavailable");
        assertThat(cancelled.httpStatus()).isEqualTo(503);
        // A trap whose stderr reads like a budget is still a trap: the termination decides.
        assertThat(sandboxFailure(new RunOutput(Termination.TRAP, 0, startedOut, utf8("wasm trap: interrupt"), null)).reason())
            .isEqualTo(Reason.TRAP);
    }

    /** The byte counts are checked again after the run: a runtime that did not stop at the cap is refused. */
    @Test
    void capsAreCheckedAgainAfterTheRun() {
        Budget small = new Budget(5, 32L * 1024 * 1024, 64, 8);
        String frame = Fixtures.frame(NONCE, "{\"errors\":[]}");
        assertThat(frame.length()).isGreaterThan(64);
        assertThatThrownBy(() -> RunClassifier.sandboxAnswer(RunOutput.exited(0, utf8(frame), null), NONCE, small))
            .isInstanceOfSatisfying(SandboxException.class, e -> assertThat(e.reason()).isEqualTo(Reason.OUTPUT_CAP));
        Budget roomy = new Budget(5, 32L * 1024 * 1024, frame.length(), 8);
        assertThat(RunClassifier.sandboxAnswer(RunOutput.exited(0, utf8(frame), utf8("12345678")), NONCE, roomy)).isNotEmpty();
        assertThatThrownBy(() -> RunClassifier.sandboxAnswer(RunOutput.exited(0, utf8(frame), utf8("123456789")), NONCE, roomy))
            .isInstanceOfSatisfying(SandboxException.class, e -> assertThat(e.reason()).isEqualTo(Reason.OUTPUT_CAP));
    }

    @Test
    void stderrIsTrimmedAndClipped() {
        RunOutput output = RunOutput.exited(1, null, utf8("\n\t x \u000B\0\f"));
        assertThat(RunClassifier.stderrText(output)).isEqualTo("x");
        RunOutput long_ = RunOutput.exited(1, null, utf8("y".repeat(70_000)));
        assertThat(RunClassifier.stderrText(long_)).hasSize(64 * 1024);
    }

    /** The PDF program's run: stdout as it is on exit 0, otherwise the limits before the start failure. */
    @Test
    void pdfTable() {
        Budget pdf = ProgramLimits.defaults().pdfBudget();
        assertThat(new String(RunClassifier.pdfAnswer(RunOutput.exited(0, utf8("{\"ok\":true}\n"), utf8("warn")), pdf), StandardCharsets.UTF_8))
            .isEqualTo("{\"ok\":true}\n");
        assertThatThrownBy(() -> RunClassifier.pdfAnswer(RunOutput.exited(134, null, utf8("wasm trap: interrupt")), pdf))
            .isInstanceOfSatisfying(SandboxException.class, e -> {
                assertThat(e.reason()).isEqualTo(Reason.BUDGET);
                assertThat(e.guestStopped()).isFalse();
            });
        assertThatThrownBy(() -> RunClassifier.pdfAnswer(RunOutput.exited(1, null, utf8("InternalError: out of memory")), pdf))
            .isInstanceOfSatisfying(SandboxException.class, e -> assertThat(e.reason()).isEqualTo(Reason.MEMORY));
        assertThatThrownBy(() -> RunClassifier.pdfAnswer(RunOutput.exited(127, null, null), pdf))
            .isInstanceOf(ProgramUnavailableException.class);
        assertThatThrownBy(() -> RunClassifier.pdfAnswer(RunOutput.exited(1, null, utf8("Error: No such file x")), pdf))
            .isInstanceOf(ProgramUnavailableException.class);
        assertThatThrownBy(() -> RunClassifier.pdfAnswer(RunOutput.exited(1, null, utf8("TypeError: x")), pdf))
            .isInstanceOfSatisfying(SandboxException.class, e -> assertThat(e.reason()).isEqualTo(Reason.THREW));
        for (Termination stop : new Termination[] {Termination.BUDGET, Termination.MEMORY, Termination.TRAP, Termination.OUTPUT_CAP, Termination.INTERRUPTED}) {
            assertThatThrownBy(() -> RunClassifier.pdfAnswer(new RunOutput(stop, 0, utf8("{\"ok\":true}"), null, null), pdf))
                .as(stop.name())
                .isInstanceOfSatisfying(SandboxException.class, e -> assertThat(e.reason().name()).isEqualTo(stop == Termination.TRAP ? "TRAP" : stop.name()));
        }
        // A render past the backstop that would not stop: the budget answer, in the PDF's words.
        assertThatThrownBy(() -> RunClassifier.pdfAnswer(new RunOutput(Termination.STUCK, -1, utf8("{\"ok\":true}"), null, null), pdf))
            .isInstanceOfSatisfying(SandboxException.class, e -> {
                assertThat(e.reason()).isEqualTo(Reason.BUDGET);
                assertThat(e.code()).isEqualTo("wasm.execution_error");
                assertThat(e.guestStopped()).isFalse();
                assertThat(e.getMessage()).isEqualTo("The PDF render passed its " + pdf.seconds() + " s budget and did not stop.");
            });
    }
}
