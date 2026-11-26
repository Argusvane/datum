package com.argusvane.datum.sandbox.protocol;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.core.DatumException;
import com.argusvane.datum.core.ProgramUnavailableException;
import com.argusvane.datum.sandbox.wasi.Budget;
import com.argusvane.datum.sandbox.wasi.EngineInfo;
import com.argusvane.datum.sandbox.wasi.GuestRun;
import com.argusvane.datum.sandbox.wasi.GuestRuntime;
import com.argusvane.datum.sandbox.wasi.GuestUnavailableException;
import com.argusvane.datum.sandbox.wasi.RunOutput;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * The one place a Datum run becomes a guest run and a guest's refusal becomes the protocol's:
 * the program under its file name and run.js under {@code /app}, byte for byte as an engine reads them,
 * and a run that cannot start answered as 503 {@code server.unavailable}.
 */
class ProgramRunnerTest {

    private static final Program SANDBOX = Program.of(Program.Kind.SANDBOX, "globalThis.sandbox = 1;".getBytes(StandardCharsets.UTF_8));
    private static final Program PDF = Program.of(Program.Kind.PDF, "globalThis.pdf = 1;".getBytes(StandardCharsets.UTF_8));
    private static final Budget BUDGET = new Budget(5, 32L << 20, Budget.STDOUT_LIMIT, Budget.STDERR_LIMIT);

    /** An engine that records the runs it is given and reports the mode it is told. */
    private static final class Recording implements GuestRuntime {

        final List<GuestRun> runs = new ArrayList<>();
        volatile String mode = "jffi";
        volatile RuntimeException failure;

        @Override
        public synchronized RunOutput run(GuestRun run) {
            runs.add(run);
            if (failure != null) {
                throw failure;
            }
            return RunOutput.exited(0, "answer".getBytes(StandardCharsets.UTF_8), null);
        }

        @Override
        public EngineInfo engineInfo() {
            return new EngineInfo("recording", "1", mode, "");
        }
    }

    @Test
    void theFileNamesAreTheProgramsAndRunJsByteForByte() {
        assertThat(Program.Kind.SANDBOX.fileName()).isEqualTo("datum-sandbox-program.js");
        assertThat(Program.Kind.PDF.fileName()).isEqualTo("datum-pdf-program.js");
        assertThat(ProgramRunner.RUN_SCRIPT).isEqualTo("run.js");
        // The argv names what /app holds: the program evaluated with -I, then run.js.
        assertThat(RunScript.argv(Program.Kind.SANDBOX)).containsExactly("qjs", "--std", "-I", "/app/datum-sandbox-program.js", "/app/run.js");
        assertThat(RunScript.argv(Program.Kind.PDF)).containsExactly("qjs", "--std", "-I", "/app/datum-pdf-program.js", "/app/run.js");
    }

    @Test
    void aGuestRunHoldsTheProgramThenRunJsAndNothingElse() {
        String script = "print('café  ');\n";
        byte[] stdin = "nonce\n{}".getBytes(StandardCharsets.UTF_8);
        GuestRun run = ProgramRunner.guestRun(SANDBOX, script, RunScript.argv(Program.Kind.SANDBOX), stdin, BUDGET);
        assertThat(run.appFiles().keySet()).containsExactly("datum-sandbox-program.js", "run.js");
        assertThat(run.file("datum-sandbox-program.js")).as("exactly the bytes that were hashed").isEqualTo(SANDBOX.bytes());
        assertThat(run.file("run.js")).isEqualTo(script.getBytes(StandardCharsets.UTF_8));
        assertThat(run.argv()).isEqualTo(RunScript.argv(Program.Kind.SANDBOX));
        assertThat(run.stdinBytes()).isEqualTo(stdin);
        assertThat(run.budget()).isSameAs(BUDGET);
        assertThat(Program.Kind.of(run)).isEqualTo(Program.Kind.SANDBOX);
        GuestRun pdf = ProgramRunner.guestRun(PDF, RunScript.PDF, RunScript.argv(Program.Kind.PDF), new byte[0], BUDGET);
        assertThat(pdf.appFiles().keySet()).containsExactly("datum-pdf-program.js", "run.js");
        assertThat(Program.Kind.of(pdf)).isEqualTo(Program.Kind.PDF);
        assertThat(Program.Kind.of(GuestRun.of(java.util.Map.of("run.js", new byte[0]), List.of(), new byte[0], BUDGET))).isNull();
        assertThatThrownBy(() -> ProgramRunner.guestRun(null, "", List.of(), new byte[0], BUDGET)).isInstanceOf(NullPointerException.class);
    }

    @Test
    void aRunGoesToTheEngineAsItsGuestRunAndItsOutputComesBackAsItIs() {
        Recording engine = new Recording();
        RunOutput output = ProgramRunner.on(engine).run(SANDBOX, "print(1);", RunScript.argv(Program.Kind.SANDBOX), new byte[] {1}, BUDGET);
        assertThat(new String(output.stdout(), StandardCharsets.UTF_8)).isEqualTo("answer");
        assertThat(engine.runs).singleElement().satisfies(run -> {
            assertThat(run.file("datum-sandbox-program.js")).isEqualTo(SANDBOX.bytes());
            assertThat(run.stdinBytes()).containsExactly(1);
        });
    }

    @Test
    void aRunThatCannotStartIsTheProtocolsServiceUnavailableWithTheEnginesWords() {
        Recording engine = new Recording();
        GuestUnavailableException refusal = new GuestUnavailableException("The runtime is refusing runs: 2 stopped runs have not ended yet.");
        engine.failure = refusal;
        assertThatThrownBy(() -> ProgramRunner.on(engine).run(SANDBOX, "", List.of("qjs"), new byte[0], BUDGET))
            .isInstanceOfSatisfying(ProgramUnavailableException.class, e -> {
                assertThat(e.getMessage()).isEqualTo(refusal.getMessage());
                assertThat(((DatumException) e).code()).isEqualTo("server.unavailable");
                assertThat(((DatumException) e).httpStatus()).isEqualTo(503);
                assertThat(e.getCause()).isSameAs(refusal);
            });
        // Anything else is not the engine's outage and passes as it is.
        IllegalArgumentException budget = new IllegalArgumentException("below the module's memory");
        engine.failure = budget;
        assertThatThrownBy(() -> ProgramRunner.on(engine).run(SANDBOX, "", List.of("qjs"), new byte[0], BUDGET)).isSameAs(budget);
    }

    /** The PDF program on a bytecode engine is a typed 503 before any run. */
    @Test
    void aPdfRunOnABytecodeEngineIsRefusedBeforeTheEngineRuns() {
        Recording engine = new Recording();
        engine.mode = " BYTECODE ";
        assertThatThrownBy(() -> ProgramRunner.on(engine).run(PDF, RunScript.PDF, RunScript.argv(Program.Kind.PDF), new byte[0], BUDGET))
            .isInstanceOf(ProgramUnavailableException.class).hasMessageContaining("native").hasMessageContaining("recording");
        assertThat(engine.runs).as("nothing was run").isEmpty();
        // The sandbox program runs on bytecode (slower), and the PDF program on a native mode.
        ProgramRunner.on(engine).run(SANDBOX, "", List.of("qjs"), new byte[0], BUDGET);
        engine.mode = "panama";
        ProgramRunner.on(engine).run(PDF, RunScript.PDF, RunScript.argv(Program.Kind.PDF), new byte[0], BUDGET);
        assertThat(engine.runs).hasSize(2);
    }

    /** A report that throws or answers nothing cannot show the engine is not the bytecode one: the PDF run fails closed. */
    @Test
    void aPdfRunOnAnEngineWhoseReportFailsIsRefusedAndNothingRuns() {
        List<GuestRun> seen = new ArrayList<>();
        GuestRuntime throwing = new GuestRuntime() {
            @Override
            public RunOutput run(GuestRun run) {
                seen.add(run);
                return RunOutput.exited(0, null, null);
            }

            @Override
            public EngineInfo engineInfo() {
                throw new IllegalStateException("cannot say");
            }
        };
        GuestRuntime nothing = new GuestRuntime() {
            @Override
            public RunOutput run(GuestRun run) {
                seen.add(run);
                return RunOutput.exited(0, null, null);
            }

            @Override
            public EngineInfo engineInfo() {
                return null;
            }
        };
        for (GuestRuntime runtime : List.of(throwing, nothing)) {
            assertThat(ProgramRunner.canRunPdf(runtime)).isFalse();
            assertThatThrownBy(() -> ProgramRunner.on(runtime).run(PDF, RunScript.PDF, RunScript.argv(Program.Kind.PDF), new byte[0], BUDGET))
                .isInstanceOfSatisfying(ProgramUnavailableException.class, e -> {
                    assertThat(e.getMessage()).contains("engineInfo()").contains("forward");
                    assertThat(((DatumException) e).httpStatus()).isEqualTo(503);
                });
            // The sandbox program does not depend on the report.
            ProgramRunner.on(runtime).run(SANDBOX, "", List.of("qjs"), new byte[0], BUDGET);
        }
        assertThat(seen).as("only the two sandbox runs").hasSize(2);
    }

    /** An application's own runtime reports "unknown" by default, and is admitted. */
    @Test
    void anEngineThatReportsNothingKnownRunsThePdfProgram() {
        GuestRuntime plain = run -> RunOutput.exited(0, null, null);
        assertThat(plain.engineInfo().mode()).isEqualTo(EngineInfo.UNKNOWN);
        assertThat(ProgramRunner.canRunPdf(plain)).isTrue();
        ProgramRunner.on(plain).run(PDF, RunScript.PDF, RunScript.argv(Program.Kind.PDF), new byte[0], BUDGET);
    }

    /** One predicate for the runner, the lifecycle and health: bytecode only; "none" is the lifecycle's null delegate. */
    @Test
    void theRefusalNamesTheModeAndTheNotes() {
        assertThat(ProgramRunner.canRunPdf(new EngineInfo("e", "1", "bytecode", ""))).isFalse();
        assertThat(ProgramRunner.canRunPdf(new EngineInfo("e", "1", "none", ""))).isTrue();
        GuestRuntime bytecode = new GuestRuntime() {
            @Override
            public RunOutput run(GuestRun run) {
                throw new AssertionError("not run");
            }

            @Override
            public EngineInfo engineInfo() {
                return new EngineInfo("endive", "1.2", "bytecode", "No native runner for this platform.");
            }
        };
        assertThatThrownBy(() -> ProgramRunner.on(bytecode).run(PDF, RunScript.PDF, RunScript.argv(Program.Kind.PDF), new byte[0], BUDGET))
            .isInstanceOf(ProgramUnavailableException.class)
            .hasMessageContaining("endive").hasMessageContaining("mode bytecode").hasMessageContaining("No native runner for this platform.");
    }
}
