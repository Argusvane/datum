package com.argusvane.datum.sandbox.protocol;

import com.argusvane.datum.core.ProgramUnavailableException;
import com.argusvane.datum.sandbox.diagnostics.Guarded;
import com.argusvane.datum.sandbox.diagnostics.RunFacts;
import com.argusvane.datum.sandbox.diagnostics.RunRecorder;
import com.argusvane.datum.sandbox.wasi.RunOutput;
import java.nio.ByteBuffer;
import java.util.Locale;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.databind.JsonNode;

/**
 * One run as {@link SandboxService} and {@link PdfProgram} watch it for a {@link RunRecorder}:
 * made only when the service has a recorder, so a host that neither traces nor captures pays one null check per run. The
 * service tells it the run's output when it has one and ends it exactly once with the protocol's word for the run, after the
 * last check the protocol makes of the answer; the recorder is then told, and whatever it does never changes the answer.
 *
 * <p>The words, and which are a failed run: {@value #VERDICT} (the program answered and the protocol took it) and
 * {@value #REFUSED} (the program answered with a refusal of its own: an inspect or PDF {@code ok: false}, a probe's
 * {@code abi_mismatch}) are not; every other is: a {@link SandboxException.Reason} in lower case ({@code budget},
 * {@code memory}, {@code trap}, {@code threw}, {@code output_cap}, {@code outcome_too_large}, {@code not_json},
 * {@code no_outcome}, {@code frame}, {@code interrupted}: a stop, a cancel or the JVM out of heap), {@value #UNAVAILABLE} (the
 * runtime could not start the run, or refused it past the stray bound) and {@value #ERROR} for anything else. A run refused for
 * a busy slot never got here: the slot is taken before a watch is made.
 */
final class RunWatch {

    private static final Logger LOG = LoggerFactory.getLogger(RunWatch.class);

    /** The program answered and the protocol took the answer. */
    static final String VERDICT = "verdict";
    /** The program answered with a refusal of its own. */
    static final String REFUSED = "refused";
    /** The runtime could not start the run, or refused it. */
    static final String UNAVAILABLE = "unavailable";
    /** A failure the protocol has no word for. */
    static final String ERROR = "error";

    private final RunRecorder recorder;
    private final String program;
    private final String op;
    private final String sha256;
    private final String script;
    private final byte[] stdin;
    private final long started = System.nanoTime();
    private @Nullable RunOutput output;
    private boolean ended;

    private RunWatch(RunRecorder recorder, Program program, String op, String script, byte[] stdin) {
        this.recorder = recorder;
        this.program = program.kind() == Program.Kind.PDF ? "pdf" : "sandbox";
        this.op = op(op);
        this.sha256 = program.sha256();
        this.script = script;
        this.stdin = stdin;
    }

    /** A watch over one run, or null when there is no recorder: the run then costs nothing here. */
    static @Nullable RunWatch start(@Nullable RunRecorder recorder, Program program, String op, String script, byte[] stdin) {
        return recorder == null ? null : new RunWatch(recorder, program, op, script, stdin);
    }

    /** The runtime's output, once it has handed one back. */
    void ran(RunOutput run) {
        this.output = run;
    }

    /** Ends the run with a word of this class. */
    void end(String outcome) {
        if (ended) {
            return;
        }
        ended = true;
        try {
            recorder.ran(new RunFacts(program, op, sha256, script, ByteBuffer.wrap(stdin), output, outcome, failed(outcome),
                System.nanoTime() - started));
        } catch (Throwable e) {
            // An observer: the run's answer stands whatever the trace or the capture does, an Error included (an
            // OutOfMemoryError while building the record after a run that ran out of heap, an AssertionError from a host's
            // RunTrace); only an Error that says the JVM itself is broken goes on. The class only, never a message.
            Guarded.rethrowFatal(e);
            LOG.warn("Datum: the run diagnostics failed ({}); the run's answer is unchanged.", e.getClass().getName());
        }
    }

    /** Ends the run with the word of the failure the protocol answers it with. */
    void end(Throwable failure) {
        end(outcomeOf(failure));
    }

    /** The word of a failure: a sandbox reason in lower case, {@value #UNAVAILABLE} or {@value #ERROR}. */
    static String outcomeOf(Throwable failure) {
        if (failure instanceof SandboxException sandbox) {
            return sandbox.reason().name().toLowerCase(Locale.ROOT);
        }
        if (failure instanceof ProgramUnavailableException) {
            return UNAVAILABLE;
        }
        return ERROR;
    }

    /** The word of a sandbox reason: its name in lower case. */
    static String word(SandboxException.Reason reason) {
        return reason.name().toLowerCase(Locale.ROOT);
    }

    /** Whether a word is a failed run: every word but {@value #VERDICT} and {@value #REFUSED}. */
    static boolean failed(String outcome) {
        return !VERDICT.equals(outcome) && !REFUSED.equals(outcome);
    }

    /**
     * The word of an ABI probe's answer the gate refused: {@value #REFUSED} when the program answered an object with an
     * {@code ok} (a stale program's {@code abi_mismatch}), else what was wrong with the answer itself.
     */
    static String probeOutcome(byte[] answer) {
        JsonNode parsed;
        try {
            parsed = StrictJson.decode(answer);
        } catch (StrictJson.NotJsonException e) {
            return SandboxException.Reason.NOT_JSON.name().toLowerCase(Locale.ROOT);
        }
        return parsed.isObject() && parsed.path("ok").isBoolean() ? REFUSED : SandboxException.Reason.NO_OUTCOME.name().toLowerCase(Locale.ROOT);
    }

    /** An operation word: the host's own ({@code validate}, {@code render}), or {@code other} for anything that is not a plain word. */
    static String op(@Nullable String op) {
        if (op == null || op.isEmpty() || op.length() > 32) {
            return "other";
        }
        for (int i = 0; i < op.length(); i++) {
            char c = op.charAt(i);
            if (!(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_')) {
                return "other";
            }
        }
        return op;
    }
}
