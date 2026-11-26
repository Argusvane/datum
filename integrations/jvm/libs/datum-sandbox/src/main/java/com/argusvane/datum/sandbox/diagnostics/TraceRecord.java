package com.argusvane.datum.sandbox.diagnostics;

import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import org.jspecify.annotations.Nullable;

/**
 * One run's trace: how it ran and how it ended, and nothing it carried. The fields, in the order
 * {@link #line()} prints them as {@code key=value} pairs: {@code run program op abi engine mode slotWaitMs prepareMs
 * instantiateMs startMs totalMs termination exit outcome stdinBytes stdoutBytes stderrBytes capture}.
 *
 * <p>What it never holds: an answer, the definition, a byte of stdin, stdout or stderr (only their lengths), the run's nonce
 * (the run id is random and is not the nonce) or a file path (the capture is named by its id). Every text field is printed
 * through {@link #word}, so nothing in it can split the line or forge another field.
 *
 * @param run a random 12-hex run id, which names the capture too
 * @param program {@code sandbox} or {@code pdf}
 * @param op the protocol's operation, where it knows it
 * @param abi the program's ABI, as its store reads it, or null when the run's program is not the store's
 * @param engine the engine's id
 * @param mode the engine's mode ({@code panama}, {@code jffi}, {@code bytecode}, {@code unknown})
 * @param slotWaitNanos how long the run waited for its slot, or -1 (a run that takes none)
 * @param prepareNanos the harness's set-up, or -1 (unknown: a runtime that does not measure, or a step not run)
 * @param instantiateNanos the module's instantiation, or -1
 * @param startNanos the module's {@code _start}, or -1
 * @param totalNanos from handing the run to the runtime to the protocol's judgement
 * @param termination how the runtime said the run ended ({@code exited}, {@code budget}, ...), or null when it handed back no run
 * @param exit the guest's exit code when it exited, else null
 * @param outcome the protocol's word ({@link RunFacts#outcome()})
 * @param stdinBytes the stdin's length
 * @param stdoutBytes stdout's length, 0 when there was no run
 * @param stderrBytes stderr's length, 0 when there was no run
 * @param capture the id of the capture this run was queued under, {@code dropped} when it was not kept, or null for none
 * @param failed whether the run failed as {@code RunWatch} judges it (not printed: the outcome says it)
 */
public record TraceRecord(String run, String program, @Nullable String op, @Nullable String abi, String engine, String mode,
                          long slotWaitNanos, long prepareNanos, long instantiateNanos, long startNanos, long totalNanos,
                          @Nullable String termination, @Nullable Integer exit, String outcome, long stdinBytes, long stdoutBytes,
                          long stderrBytes, @Nullable String capture, boolean failed) {

    /** The longest a text field is printed. */
    static final int MAX_WORD = 128;

    public TraceRecord {
        Objects.requireNonNull(run, "run");
        Objects.requireNonNull(program, "program");
        Objects.requireNonNull(engine, "engine");
        Objects.requireNonNull(mode, "mode");
        Objects.requireNonNull(outcome, "outcome");
    }

    /** The same record queued under a capture id (or marked {@code dropped}). */
    public TraceRecord withCapture(@Nullable String id) {
        return new TraceRecord(run, program, op, abi, engine, mode, slotWaitNanos, prepareNanos, instantiateNanos, startNanos, totalNanos,
            termination, exit, outcome, stdinBytes, stdoutBytes, stderrBytes, id, failed);
    }

    /**
     * The fields in their fixed order, as printed: text fields as {@link #word} prints them (null as {@code -}), times in
     * milliseconds with one decimal (unknown as {@code -}), counts as numbers. A capture's {@code meta.json} holds the same map.
     */
    public Map<String, Object> fields() {
        Map<String, Object> fields = new LinkedHashMap<>();
        fields.put("run", word(run));
        fields.put("program", word(program));
        fields.put("op", word(op));
        fields.put("abi", word(abi));
        fields.put("engine", word(engine));
        fields.put("mode", word(mode));
        fields.put("slotWaitMs", millis(slotWaitNanos));
        fields.put("prepareMs", millis(prepareNanos));
        fields.put("instantiateMs", millis(instantiateNanos));
        fields.put("startMs", millis(startNanos));
        fields.put("totalMs", millis(totalNanos));
        fields.put("termination", word(termination));
        fields.put("exit", exit == null ? "-" : exit);
        fields.put("outcome", word(outcome));
        fields.put("stdinBytes", stdinBytes);
        fields.put("stdoutBytes", stdoutBytes);
        fields.put("stderrBytes", stderrBytes);
        fields.put("capture", word(capture));
        return fields;
    }

    /** The trace line: every field of {@link #fields()} as {@code key=value}, one space between, in order. */
    public String line() {
        StringBuilder line = new StringBuilder(256);
        for (Map.Entry<String, Object> field : fields().entrySet()) {
            if (!line.isEmpty()) {
                line.append(' ');
            }
            line.append(field.getKey()).append('=').append(field.getValue());
        }
        return line.toString();
    }

    /** A line, not the record's default text: the same fields. */
    @Override
    public String toString() {
        return line();
    }

    /**
     * A text field as the line prints it: {@code -} for none, else ASCII letters, digits, {@code .}, {@code _} and {@code -}
     * kept and every other character an {@code _}, at most {@value #MAX_WORD} characters. So no value can hold a space, an
     * {@code =}, a line break or a control character, whatever an engine or a runtime reports.
     */
    static String word(@Nullable String value) {
        if (value == null || value.isEmpty()) {
            return "-";
        }
        int length = Math.min(value.length(), MAX_WORD);
        StringBuilder out = new StringBuilder(length);
        for (int i = 0; i < length; i++) {
            char c = value.charAt(i);
            boolean plain = c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '.' || c == '_' || c == '-';
            out.append(plain ? c : '_');
        }
        return out.toString();
    }

    /** Nanoseconds as milliseconds with one decimal, or {@code -} for unknown. */
    static String millis(long nanos) {
        return nanos < 0 ? "-" : String.format(Locale.ROOT, "%.1f", nanos / 1e6);
    }
}
