package com.argusvane.datum.sandbox.diagnostics;

import com.argusvane.datum.sandbox.wasi.RunOutput;
import com.argusvane.datum.sandbox.wasi.Termination;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;

/** Captures for the tests: a failed run's facts with stdout of a chosen size, under ids that sort by a counter. */
final class Captures {

    private static final AtomicLong RUNS = new AtomicLong(0x100000000L);

    private Captures() {
    }

    /** A fresh 12-hex run id, increasing, so the captures it names sort in the order they were made. */
    static String runId() {
        return HexFormat.of().toHexDigits(RUNS.incrementAndGet()).substring(4);
    }

    /** The id of a capture made at this second of a fixed day, for a fresh run id. */
    static String id(int second) {
        return RunCapture.id(Instant.parse("2026-11-23T10:00:00Z").plusSeconds(second), runId());
    }

    /** A trapped sandbox run's facts: the stdin text, and stdout of {@code stdoutBytes} bytes of 'o'. */
    static RunFacts trapped(String stdin, int stdoutBytes) {
        byte[] stdout = new byte[stdoutBytes];
        Arrays.fill(stdout, (byte) 'o');
        RunOutput output = new RunOutput(Termination.TRAP, -1, stdout, "trapped".getBytes(StandardCharsets.UTF_8), "unreachable");
        return new RunFacts("sandbox", "validate", "ab".repeat(32), "print(1);\n", ByteBuffer.wrap(stdin.getBytes(StandardCharsets.UTF_8)),
            output, "trap", true, 1_000_000);
    }

    /** A capture of a trapped run with this much stdout. */
    static RunCapture of(String id, int stdoutBytes) {
        return RunCapture.of(id, trapped("{\"values\":{\"name\":\"Ada\"}}", stdoutBytes), Map.of("capture", id));
    }
}
