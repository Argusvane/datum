package com.argusvane.datum.sandbox.protocol;

import com.argusvane.datum.core.ProgramUnavailableException;
import com.argusvane.datum.sandbox.protocol.SandboxException.Reason;
import com.argusvane.datum.sandbox.wasi.Budget;
import com.argusvane.datum.sandbox.wasi.RunOutput;
import com.argusvane.datum.sandbox.wasi.Termination;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;

/**
 * What a finished run means, for the sandbox program and for the PDF program.
 *
 * <p>Only an exit of 0 whose stdout is exactly the answer between this run's markers is a sandbox answer
 * ({@link Frame}). A rule module cannot print the markers (it never sees the nonce), and bytes it writes
 * elsewhere in stdout refuse the run. Anything else is a failure, told apart by how the run ended and by
 * whether the guest's first line ran (the "started" marker): before it, stderr is the runtime's or QuickJS's
 * own, so exit 127 or "No such file" means the runtime could not start; after it, stderr is the guest's to
 * write (a thrown message is printed there), so those words prove nothing and the run is an ordinary
 * failure. The budget words on stderr stay as labels only, because a budget and an error answer the same
 * 503 {@code wasm.execution_error}, and a stop counts as the guest's own
 * ({@link SandboxException#guestStopped()}) only when the markers say it had started.
 *
 * <p>A run the host's backstop found still going after its cancel ({@link Termination#STUCK}) is a budget stop for its
 * caller, as on the Python host: it did pass its budget, so {@code server.unavailable} would call it an outage; it is
 * never the guest's own stop, since a runtime that could not stop it proves nothing about the definition.
 *
 * <p>The order: the runtime's own stops (the output cap, the time budget, a stuck run, a cancel) come first, because a stopped
 * run is never an answer whatever its stdout holds (a frame written before the cap included); then the byte counts
 * are checked again against the caps, so a runtime that did not stop at a cap is refused too; then the exit is
 * read. No runtime here loads a precompiled module, so "failed deserialization" on stderr is an ordinary failure
 * (words prove nothing).
 */
public final class RunClassifier {

    private RunClassifier() {
    }

    /**
     * The framed answer of a sandbox run, or the reason there is none.
     *
     * @param output what the runtime handed back
     * @param nonce the run's nonce
     * @param budget the run's budget, for the caps and the messages
     * @return the answer's bytes (UTF-8, not yet decoded), trimmed
     * @throws SandboxException when the run gave no answer
     * @throws ProgramUnavailableException when the runtime could not start the program
     */
    public static byte[] sandboxAnswer(RunOutput output, String nonce, Budget budget) {
        // Views, not copies: stdout and stderr can each be the cap (32 MiB) and a run is judged on every request.
        ByteBuffer stdout = output.stdoutView();
        String stderr = stderrText(output);
        boolean started = Frame.started(stdout, nonce);
        switch (output.termination()) {
            case OUTPUT_CAP -> throw outputCap(budget, stderr);
            case BUDGET -> throw new SandboxException(Reason.BUDGET,
                "The sandbox run passed its " + budget.seconds() + " s budget.", stderr, started);
            // Past its budget and the host's backstop, and still going after the cancel: a budget stop all the same,
            // but the runtime's failure to stop it proves nothing about the definition, so never the guest's own.
            case STUCK -> throw new SandboxException(Reason.BUDGET,
                "The sandbox run passed its " + budget.seconds() + " s budget and did not stop.", stderr);
            case INTERRUPTED -> throw new SandboxException(Reason.INTERRUPTED,
                "The sandbox run was cancelled by the host before it answered.", stderr);
            default -> {
            }
        }
        if (output.stdoutLength() > budget.stdoutCap() || output.stderrLength() > budget.stderrCap()) {
            throw outputCap(budget, stderr);
        }
        if (output.termination() == Termination.EXITED && output.exitCode() == 0) {
            byte[] answer = Frame.framed(stdout, nonce);
            if (answer == null) {
                if (Frame.hasStrayOutput(stdout, nonce)) {
                    throw new SandboxException(Reason.FRAME, "The sandbox wrote outside its answer frame.", stderr);
                }
                throw new SandboxException(Reason.NO_OUTCOME, "The sandbox printed no outcome.", stderr);
            }
            return answer;
        }
        if (!started && output.termination() == Termination.EXITED
            && (output.exitCode() == 127 || stderr.contains("No such file"))) {
            throw new ProgramUnavailableException("The runtime could not start the sandbox program.");
        }
        return failed(output, stderr, started, budget, "sandbox run", "sandbox program");
    }

    /**
     * The answer of a PDF program run: its whole stdout on exit 0 (no frame: no untrusted module is
     * registered there), else the failure. Its order differs from the sandbox's: there are no markers, so no stop
     * is the guest's own and stderr is the trusted program's or the runtime's; the limit words are read before the
     * start failure, so a render that ran out of time is a budget stop, not "could not start".
     *
     * @return stdout's bytes
     * @throws SandboxException when the run gave no answer
     * @throws ProgramUnavailableException when the runtime could not start the program
     */
    public static byte[] pdfAnswer(RunOutput output, Budget budget) {
        String stderr = stderrText(output);
        switch (output.termination()) {
            case OUTPUT_CAP -> throw new SandboxException(Reason.OUTPUT_CAP,
                "The PDF render wrote more than its output limit (" + budget.stdoutCap() + " bytes to stdout, "
                    + budget.stderrCap() + " to stderr).", stderr);
            case BUDGET -> throw new SandboxException(Reason.BUDGET,
                "The PDF render passed its " + budget.seconds() + " s budget.", stderr);
            case STUCK -> throw new SandboxException(Reason.BUDGET,
                "The PDF render passed its " + budget.seconds() + " s budget and did not stop.", stderr);
            case INTERRUPTED -> throw new SandboxException(Reason.INTERRUPTED,
                "The PDF render was cancelled by the host before it answered.", stderr);
            case MEMORY -> throw new SandboxException(Reason.MEMORY, "The PDF render passed its memory budget.", stderr);
            case TRAP -> throw new SandboxException(Reason.TRAP, "The PDF program trapped.", stderr);
            default -> {
            }
        }
        if (output.stdoutLength() > budget.stdoutCap() || output.stderrLength() > budget.stderrCap()) {
            throw new SandboxException(Reason.OUTPUT_CAP, "The PDF render wrote more than its output limit.", stderr);
        }
        if (output.exitCode() == 0) {
            return output.stdout();
        }
        if (stderr.contains("wasm trap: interrupt")) {
            throw new SandboxException(Reason.BUDGET, "The PDF render passed its " + budget.seconds() + " s budget.", stderr);
        }
        if (stderr.contains("out of memory") || stderr.contains("memory size")) {
            throw new SandboxException(Reason.MEMORY, "The PDF render passed its memory budget.", stderr);
        }
        if (output.exitCode() == 127 || stderr.contains("No such file")) {
            throw new ProgramUnavailableException("The runtime could not start the PDF program.");
        }
        throw new SandboxException(Reason.THREW, "The PDF program threw.", stderr);
    }

    /** A run that did not exit 0 and could start: a limit or a failure, labelled. */
    private static byte[] failed(RunOutput output, String stderr, boolean started, Budget budget, String run, String program) {
        if (output.termination() == Termination.MEMORY) {
            throw new SandboxException(Reason.MEMORY, "The " + run + " passed its memory budget.", stderr, started);
        }
        if (output.termination() == Termination.TRAP) {
            throw new SandboxException(Reason.TRAP, "The " + program + " trapped.", stderr);
        }
        // The guest ran into the limit only when it had started: before that the words are the runtime's own
        // and prove nothing about what was asked of it.
        if (stderr.contains("wasm trap: interrupt")) {
            throw new SandboxException(Reason.BUDGET, "The " + run + " passed its " + budget.seconds() + " s budget.", stderr, started);
        }
        if (stderr.contains("out of memory") || stderr.contains("memory size")) {
            throw new SandboxException(Reason.MEMORY, "The " + run + " passed its memory budget.", stderr, started);
        }
        throw new SandboxException(Reason.THREW, "The " + program + " threw.", stderr);
    }

    private static SandboxException outputCap(Budget budget, String stderr) {
        return new SandboxException(Reason.OUTPUT_CAP, "The sandbox run wrote more than its output limit ("
            + budget.stdoutCap() + " bytes to stdout, " + budget.stderrCap() + " to stderr).", stderr);
    }

    /**
     * stderr as text for the log and the stderr word checks: without the leading and trailing bytes
     * {@link String#trim()} drops (space and the ASCII controls), and clipped to 64 KiB.
     */
    static String stderrText(RunOutput output) {
        ByteBuffer bytes = output.stderrView();
        int start = 0;
        int stop = bytes.limit();
        while (start < stop && (bytes.get(start) & 0xff) <= ' ') {
            start++;
        }
        while (stop > start && (bytes.get(stop - 1) & 0xff) <= ' ') {
            stop--;
        }
        byte[] kept = new byte[Math.min(stop - start, SandboxException.STDERR_KEPT)];
        bytes.get(start, kept);
        return new String(kept, StandardCharsets.UTF_8);
    }
}
