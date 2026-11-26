package com.argusvane.datum.sandbox.protocol;

import com.argusvane.datum.core.DatumException;
import com.argusvane.datum.sandbox.wasi.Budget;
import java.nio.charset.StandardCharsets;
import java.util.Objects;
import org.jspecify.annotations.Nullable;

/**
 * A sandbox or PDF program run that produced no usable answer.
 *
 * <p>The wire tells four outcomes apart, every one a 503 (endpoint catalog: {@code wasm.execution_error},
 * {@code outcome_too_large}, {@code server.busy} with {@code Retry-After}, {@code server.unavailable}): a run that gave no
 * answer is the server's failure, never a judgement of the answers, so it is no 422 a browser would show as "your answers
 * are wrong" (the same on the submission, check, dry-run, inspect and PDF routes; a check's
 * own {@code definition.tooCostly} stays the author's 422). The {@link Reason} is finer, for
 * the log and for {@link #guestStopped()}: a budget stop is {@link Reason#BUDGET}, {@link Reason#MEMORY} or
 * {@link Reason#OUTPUT_CAP}; a failed run is {@link Reason#THREW}, {@link Reason#TRAP}, {@link Reason#FRAME},
 * {@link Reason#NO_OUTCOME}, {@link Reason#NOT_JSON}, {@link Reason#REFUSED} or {@link Reason#INPUT}; no free slot
 * is {@link Reason#BUSY}. A program that cannot be used is
 * {@link com.argusvane.datum.core.ProgramUnavailableException} and the typed {@code definition.tooDeep} is
 * {@link com.argusvane.datum.core.DefinitionTooDeepException}.
 *
 * <p>The message is the host's own words: it never carries the guest's stderr or output,
 * which go to the log only through {@link #stderr()} and {@link #programMessage()}. Only a stop
 * the guest itself ran into (its time or memory limit after the program printed its started marker) says so
 * in {@link #guestStopped()}: the output cap or a cancelled run proves nothing about the definition, and only
 * the former lets a {@code check} blame the definition ({@code definition.tooCostly}).
 */
public class SandboxException extends DatumException {

    private static final long serialVersionUID = 1L;

    /** The longest stderr kept, in bytes: the run's stderr cap ({@link Budget#STDERR_LIMIT}). */
    static final int STDERR_KEPT = (int) Budget.STDERR_LIMIT;

    /** Why a run gave no answer. */
    public enum Reason {
        /**
         * The run passed its time budget: stopped at it, or found still going past the host's backstop and cancelled
         * ({@link com.argusvane.datum.sandbox.wasi.Termination#STUCK} included, whose thread may outlive the answer).
         */
        BUDGET("wasm.execution_error", 503),
        /** The run passed its memory budget. */
        MEMORY("wasm.execution_error", 503),
        /** The module trapped. */
        TRAP("wasm.execution_error", 503),
        /** The program threw: a non-zero exit that was neither a limit nor a failure to start. */
        THREW("wasm.execution_error", 503),
        /** The run wrote past an output cap and was stopped. */
        OUTPUT_CAP("wasm.execution_error", 503),
        /**
         * The run's outcome was longer than 8 MiB of UTF-16 code units:
         * nothing of it is kept. A code of its own, so the log and a client can tell it from a stopped run; a 503 like
         * them, since no verdict was reached.
         */
        OUTCOME_TOO_LARGE("outcome_too_large", 503),
        /** The answer in the frame is not strict JSON ({@link StrictJson}). */
        NOT_JSON("wasm.execution_error", 503),
        /** Exit 0 with no frame, or a frame with no outcome (an object with an {@code errors} list) in it. */
        NO_OUTCOME("wasm.execution_error", 503),
        /** Exit 0 with this run's whole frame but bytes outside it: a module wrote to stdout. */
        FRAME("wasm.execution_error", 503),
        /** The program refused the request ({@code ok: false}): {@link #programCode()} says why. */
        REFUSED("wasm.execution_error", 503),
        /** The run's input could not be written as JSON (a non-finite number): the receiver's backstop. */
        INPUT("wasm.execution_error", 503),
        /**
         * Every run slot stayed taken for the wait: nothing was judged, try again. The wire code is 503
         * {@code server.busy} (endpoint catalog), which the conformance suite's REC-16 and the browser glue read;
         * {@code busy} is not a second code.
         */
        BUSY("server.busy", 503),
        /**
         * The host cancelled the run (shutdown, an interrupted request thread): nothing was judged. Never a run that
         * passed its budget, however it ended ({@link #BUDGET}).
         */
        INTERRUPTED("server.unavailable", 503);

        private final String code;
        private final int httpStatus;

        Reason(String code, int httpStatus) {
            this.code = code;
            this.httpStatus = httpStatus;
        }

        /** The wire code a failure of this reason answers with. */
        public String code() {
            return code;
        }

        /** The status a failure of this reason answers with. */
        public int httpStatus() {
            return httpStatus;
        }
    }

    private final Reason reason;
    private final String stderr;
    private final boolean guestStopped;
    private final @Nullable String typedCode;
    private final @Nullable String programCode;
    private final @Nullable String programMessage;

    public SandboxException(Reason reason, String message) {
        this(reason, message, "", false, null, null, null, null);
    }

    public SandboxException(Reason reason, String message, String stderr) {
        this(reason, message, stderr, false, null, null, null, null);
    }

    public SandboxException(Reason reason, String message, String stderr, boolean guestStopped) {
        this(reason, message, stderr, guestStopped, null, null, null, null);
    }

    /**
     * The full form.
     *
     * @param typedCode a typed wire code that replaces the reason's ({@code definition.tooCostly}), or null
     * @param programCode the program's own error code for {@link Reason#REFUSED}, or null
     * @param programMessage the program's own error message for {@link Reason#REFUSED}; for the log only
     */
    public SandboxException(Reason reason, String message, String stderr, boolean guestStopped, @Nullable String typedCode,
                            @Nullable String programCode, @Nullable String programMessage, @Nullable Throwable cause) {
        super(typedCode != null ? typedCode : Objects.requireNonNull(reason, "reason").code(),
            typedCode != null ? 422 : reason.httpStatus(), message, cause);
        this.reason = reason;
        this.stderr = clip(stderr == null ? "" : stderr);
        this.guestStopped = guestStopped;
        this.typedCode = typedCode;
        this.programCode = programCode;
        this.programMessage = programMessage;
    }

    /**
     * A check stopped at its own time or memory limit after the program started: the definition is too large
     * or too tangled to judge, the author's to simplify (422 {@code definition.tooCostly}), not the runtime
     * being unavailable.
     */
    public static SandboxException checkTooCostly(SandboxException budget) {
        return new SandboxException(budget.reason(),
            "The definition is too large or too complex to check within the time or memory the sandbox allows.",
            budget.stderr(), true, "definition.tooCostly", null, null, budget);
    }

    /** The reason, lower case, as the observation's {@code outcome} word ({@code busy}, {@code budget}, ...). */
    @Override
    public String observationOutcome() {
        return reason().name().toLowerCase(java.util.Locale.ROOT);
    }

    /** Why the run gave no answer. */
    public Reason reason() {
        return reason;
    }

    /** What the run wrote to stderr, trimmed and clipped to 64 KiB: for the log, never for a response. */
    public String stderr() {
        return stderr;
    }

    /** Whether the guest ran into its own time or memory limit after it started. */
    public boolean guestStopped() {
        return guestStopped;
    }

    /** The typed code that replaced the reason's, or null. */
    public @Nullable String typedCode() {
        return typedCode;
    }

    /** The program's error code when it refused the request, or null. */
    public @Nullable String programCode() {
        return programCode;
    }

    /** The program's error message when it refused the request, or null; for the log only. */
    public @Nullable String programMessage() {
        return programMessage;
    }

    static String clip(String text) {
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        if (bytes.length <= STDERR_KEPT) {
            return text;
        }
        return new String(bytes, 0, STDERR_KEPT, StandardCharsets.UTF_8);
    }
}
