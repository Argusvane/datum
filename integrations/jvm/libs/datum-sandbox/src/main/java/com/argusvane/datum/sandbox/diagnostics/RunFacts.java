package com.argusvane.datum.sandbox.diagnostics;

import com.argusvane.datum.sandbox.wasi.RunOutput;
import java.nio.ByteBuffer;
import java.util.Objects;
import org.jspecify.annotations.Nullable;

/**
 * One finished run as the protocol saw it, handed to a {@link RunRecorder} after the protocol judged it: what the run trace
 * and the failed-run capture are both built from. The protocol fills it in; the runtime adds
 * what only it knows (the run id, the program's ABI, the engine and the slot wait).
 *
 * <p>It holds the run's input and output by reference, as read-only views, never as copies: a recorder that keeps nothing
 * costs nothing, and the capture's bounded queue is what bounds how long a kept one lives.
 *
 * @param program {@code sandbox} or {@code pdf}
 * @param op the protocol's operation ({@code validate}, {@code inspect}, {@code check}, {@code public}, {@code abi}, or the PDF
 *     program's op such as {@code render}); a fixed word of the host's, never request text
 * @param sha256 the program file's sha256, which pins the program a capture ran
 * @param runScript the generated {@code run.js}
 * @param stdin everything the guest could read (the nonce line included for the sandbox program)
 * @param output what the runtime handed back, or null when the run did not start or the runtime answered nothing
 * @param outcome the protocol's word for how the run ended: {@code verdict} or {@code refused} (the program answered), else
 *     the failure ({@code budget}, {@code memory}, {@code trap}, {@code threw}, {@code output_cap}, {@code outcome_too_large},
 *     {@code not_json}, {@code no_outcome}, {@code frame}, {@code interrupted}, {@code unavailable}, {@code error})
 * @param failed whether the run is a failed run in the sense of {@link RunWatch}: no answer the protocol could take
 * @param totalNanos from handing the run to the runtime to the protocol's judgement
 */
public record RunFacts(String program, String op, String sha256, String runScript, ByteBuffer stdin, @Nullable RunOutput output,
                       String outcome, boolean failed, long totalNanos) {

    public RunFacts {
        Objects.requireNonNull(program, "program");
        Objects.requireNonNull(op, "op");
        Objects.requireNonNull(sha256, "sha256");
        Objects.requireNonNull(runScript, "runScript");
        stdin = Objects.requireNonNull(stdin, "stdin").asReadOnlyBuffer();
        Objects.requireNonNull(outcome, "outcome");
    }

    /** The stdin, a fresh read-only view. */
    @Override
    public ByteBuffer stdin() {
        return stdin.duplicate();
    }
}
