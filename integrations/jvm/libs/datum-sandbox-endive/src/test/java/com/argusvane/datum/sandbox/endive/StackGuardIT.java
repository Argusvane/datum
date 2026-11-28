package com.argusvane.datum.sandbox.endive;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.sandbox.protocol.Nonce;
import com.argusvane.datum.sandbox.protocol.Program;
import com.argusvane.datum.sandbox.protocol.ProgramRunner;
import com.argusvane.datum.sandbox.protocol.RunClassifier;
import com.argusvane.datum.sandbox.protocol.RunScript;
import com.argusvane.datum.sandbox.protocol.SandboxException;
import com.argusvane.datum.sandbox.tck.RuntimeTckAssets;
import com.argusvane.datum.sandbox.wasi.Budget;
import com.argusvane.datum.sandbox.wasi.RunOutput;
import com.argusvane.datum.sandbox.wasi.Termination;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import run.endive.wasm.Parser;

/**
 * The guest's C stack is held to its 64 KiB on every runner: the failsafe execution (JFFI), panama-it (Panama) and the
 * bytecode-fallback surefire execution all run this class. Ordinary depth is untouched; recursion past the stack, a frame
 * that reserves more than it writes (so a canary alone could be stepped over), and native recursion in the engine itself
 * each end as a trap that says the stack reached its floor, which the protocol reads as a failed run (503, no verdict),
 * and the next run is fine.
 */
class StackGuardIT {

    private static final EndiveGuestRuntime RUNTIME = new EndiveGuestRuntime();
    private static final List<String> ARGV = List.of("qjs", "--std", "/app/run.js");

    @AfterAll
    static void stop() {
        RUNTIME.close();
    }

    private static RunOutput run(String script) {
        return RUNTIME.run(ProgramRunner.guestRun(RuntimeTckAssets.sandboxProgram(), script, ARGV, new byte[0],
            new Budget(60, 32L << 20, Budget.STDOUT_LIMIT, Budget.STDERR_LIMIT)));
    }

    private static String recurse(int depth) {
        return "var f = function (n) { return n === " + depth + " ? 0 : f(n + 1) + 1; }; print(f(0));";
    }

    /** Recursion whose every frame reserves room for a call of {@code width} arguments it never makes. */
    private static String wideFrames(int depth) {
        String zeros = String.join(",", java.util.Collections.nCopies(640, "0"));
        return "function g() { return 0; }\n"
            + "function f(n) { if (n > 0) return f(n - 1) + 0; if (n < 0) return g(" + zeros + "); return 0; }\n"
            + "print(f(" + depth + "));";
    }

    private static void assertOverrun(RunOutput output) {
        assertThat(output.termination()).as(output.trapMessage()).isEqualTo(Termination.TRAP);
        assertThat(output.trapMessage()).startsWith(StackGuard.OVERRUN);
    }

    @Test
    void theRuntimeSaysWhereTheStackIsAndHowItIsHeld() {
        assertThat(RUNTIME.engineInfo().notes()).contains("C stack guard: 139040..204576").contains("stack pointer writes held to 139552..204576");
    }

    @Test
    void ordinaryRecursionIsUntouched() {
        RunOutput output = run(recurse(100));
        assertThat(output.termination()).as(output.trapMessage()).isEqualTo(Termination.EXITED);
        assertThat(new String(output.stdout(), StandardCharsets.UTF_8)).isEqualTo("100\n");
    }

    @Test
    void recursionPastTheStackIsATrapAndTheNextRunIsFine() {
        assertOverrun(run(recurse(300)));
        assertThat(run(recurse(100)).exitCode()).as("the next run").isZero();
    }

    @Test
    void aFrameThatReservesMoreThanItWritesCannotStepOverTheCanary() {
        Map<Integer, RunOutput> ends = new LinkedHashMap<>();
        for (int depth = 0; depth < 16; depth++) {
            ends.put(depth, run(wideFrames(depth)));
        }
        ends.forEach((depth, output) -> {
            if (output.termination() == Termination.EXITED) {
                assertThat(new String(output.stdout(), StandardCharsets.UTF_8)).as("depth %d", depth).isEqualTo("0\n");
            } else {
                assertOverrun(output);
            }
        });
        for (int depth = 0; depth < 8; depth++) {
            assertThat(ends.get(depth).termination()).as("ordinary depth %d", depth).isEqualTo(Termination.EXITED);
        }
        for (int depth = 12; depth < 16; depth++) {
            assertOverrun(ends.get(depth));
        }
    }

    /**
     * JSON.parse recurses in C with small frames, so on a native runner Endive's call stack runs out first; on bytecode,
     * whose call stack is the JVM's, the C stack reaches its floor first (unguarded, this run went on over its own statics
     * and ended in an out-of-bounds access). Either way a trap, never an answer.
     */
    @Test
    void nativeRecursionInTheEngineIsATrap() {
        RunOutput output = run("var n = 20000; JSON.parse('['.repeat(n) + ']'.repeat(n)); print('parsed');");
        assertThat(output.termination()).as(output.trapMessage()).isEqualTo(Termination.TRAP);
        assertThat(output.trapMessage()).satisfiesAnyOf(message -> assertThat(message).startsWith(StackGuard.OVERRUN),
            message -> assertThat(message).contains("call stack exhausted"));
        if (!RUNTIME.isNative()) {
            assertOverrun(output);
        }
    }

    /** A validation of one text field, its value and its visibleWhen rule as given, straight to the program. */
    private static void assertValidationIsAFailedRun(String value, String visibleWhen) {
        RunScript scripts = RuntimeTckAssets.scripts();
        String nonce = Nonce.generate();
        Budget budget = new Budget(60, 32L << 20, Budget.STDOUT_LIMIT, Budget.STDERR_LIMIT);
        String rules = visibleWhen == null ? "" : ",\"rules\":{\"visibleWhen\":\"" + visibleWhen + "\"}";
        String context = "{\"formId\":\"f\",\"locale\":\"en\",\"form\":{\"id\":\"root\",\"type\":\"form\",\"configuration\":{},"
            + "\"children\":{\"content\":[{\"id\":\"name\",\"type\":\"text\",\"configuration\":{}" + rules + "},"
            + "{\"id\":\"n\",\"type\":\"number\",\"configuration\":{}}]}},\"values\":{\"name\":" + value + ",\"n\":3}}";
        RunOutput output = RUNTIME.run(ProgramRunner.guestRun(RuntimeTckAssets.sandboxProgram(), scripts.sandbox(List.of(), RunScript.Entry.RUN),
            RunScript.argv(Program.Kind.SANDBOX), Nonce.stdin(nonce, context), budget));
        assertOverrun(output);
        assertThatThrownBy(() -> RunClassifier.sandboxAnswer(output, nonce, budget)).isInstanceOfSatisfying(SandboxException.class, failed -> {
            assertThat(failed.reason()).isEqualTo(SandboxException.Reason.TRAP);
            assertThat(failed.reason().httpStatus()).isEqualTo(503);
        });
    }

    /**
     * Inputs inside the host's stated limits whose walk runs past the 64 KiB: a value nested 253 levels (the request
     * body's 256) and a rule of 99 nested parentheses (the formula parser's 100). Each is a failed run (503, no verdict).
     */
    @Test
    void aValidationWhoseStackReachesTheFloorIsAFailedRunWithNoVerdict() {
        assertValidationIsAFailedRun("[".repeat(253) + "]".repeat(253), null);
        assertValidationIsAFailedRun("\"x\"", "(".repeat(99) + "n = 3" + ")".repeat(99));
    }

    @Test
    void aClassCompiledFromTheUnrewrittenModuleIsRefused() throws Exception {
        String configured = System.getProperty("qjs.wasm.file");
        byte[] pinned = java.nio.file.Files.readAllBytes(java.nio.file.Path.of(configured != null && !configured.isBlank() ? configured
            : "target/qjs/qjs-wasi.wasm"));
        StackGuard guard = StackGuard.load(Qjs.load(), RUNTIME.info().qjsSha256());
        assertThatThrownBy(() -> guard.verify(Parser.parse(pinned))).isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("without the stack guard's check");
    }
}
