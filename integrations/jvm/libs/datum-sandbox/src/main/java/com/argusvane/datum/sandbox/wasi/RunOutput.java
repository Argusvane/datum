package com.argusvane.datum.sandbox.wasi;

import java.nio.ByteBuffer;
import java.util.Objects;
import org.jspecify.annotations.Nullable;

/**
 * What a {@link GuestRuntime} hands back from one run, before anything is read into it: however the run ended, every byte
 * the guest wrote before the end, up to the caps.
 *
 * @param termination how the run ended
 * @param exitCode the guest's exit code when {@code termination} is {@link Termination#EXITED}; otherwise
 *     whatever the engine had (ignored)
 * @param stdout every byte written to stdout, at most the budget's cap
 * @param stderr every byte written to stderr, at most the budget's cap
 * @param trapMessage the trap's description for {@link Termination#TRAP}, else {@code null}; for the log only
 * @param timings where the harness spent the run's time, for a run that asked to be timed ({@link GuestRun#timed()}); null
 *     otherwise, and from a runtime that does not measure (the diagnostics' run trace prints it as unknown)
 */
public record RunOutput(Termination termination, int exitCode, byte[] stdout, byte[] stderr, @Nullable String trapMessage,
                        @Nullable RunTimings timings) {

    public RunOutput {
        Objects.requireNonNull(termination, "termination");
        stdout = stdout == null ? new byte[0] : stdout.clone();
        stderr = stderr == null ? new byte[0] : stderr.clone();
    }

    /** A run with no timings: what every runtime that does not measure hands back. */
    public RunOutput(Termination termination, int exitCode, byte @Nullable [] stdout, byte @Nullable [] stderr, @Nullable String trapMessage) {
        this(termination, exitCode, stdout, stderr, trapMessage, null);
    }

    /** A run that exited with this code and output. */
    public static RunOutput exited(int exitCode, byte[] stdout, byte[] stderr) {
        return new RunOutput(Termination.EXITED, exitCode, stdout, stderr, null);
    }

    @Override
    public byte[] stdout() {
        return stdout.clone();
    }

    @Override
    public byte[] stderr() {
        return stderr.clone();
    }

    /**
     * A read-only view of stdout, from position 0 to its length, sharing the record's bytes: no copy, so a reader that only
     * scans (the protocol's frame and stderr checks) does not pay another copy of up to the output cap on every run.
     */
    public ByteBuffer stdoutView() {
        return ByteBuffer.wrap(stdout).asReadOnlyBuffer();
    }

    /** A read-only view of stderr, as {@link #stdoutView()}. */
    public ByteBuffer stderrView() {
        return ByteBuffer.wrap(stderr).asReadOnlyBuffer();
    }

    /** The number of bytes written to stdout. */
    public int stdoutLength() {
        return stdout.length;
    }

    /** The number of bytes written to stderr. */
    public int stderrLength() {
        return stderr.length;
    }
}
