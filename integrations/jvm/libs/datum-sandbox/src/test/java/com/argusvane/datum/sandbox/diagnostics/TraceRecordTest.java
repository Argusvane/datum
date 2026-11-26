package com.argusvane.datum.sandbox.diagnostics;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.sandbox.wasi.EngineInfo;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** The trace line: its fields in their fixed order, and nothing in a value can split or forge one. */
class TraceRecordTest {

    static final List<String> FIELDS = List.of("run", "program", "op", "abi", "engine", "mode", "slotWaitMs", "prepareMs", "instantiateMs",
        "startMs", "totalMs", "termination", "exit", "outcome", "stdinBytes", "stdoutBytes", "stderrBytes", "capture");

    private static TraceRecord record(String engine) {
        return new TraceRecord("0123456789ab", "sandbox", "validate", "2.16.0", engine, "panama", 1_250_000, 400_000, 2_000_000,
            31_000_000, 40_000_000, "exited", 0, "verdict", 120, 300, 0, null, false);
    }

    /** The keys of a line, in order. */
    static List<String> keys(String line) {
        List<String> keys = new ArrayList<>();
        for (String pair : line.split(" ")) {
            keys.add(pair.substring(0, pair.indexOf('=')));
        }
        return keys;
    }

    @Test
    void theLineHasEveryFieldInItsFixedOrder() {
        String line = record("endive").line();
        assertThat(keys(line)).containsExactlyElementsOf(FIELDS);
        assertThat(line).isEqualTo("run=0123456789ab program=sandbox op=validate abi=2.16.0 engine=endive mode=panama slotWaitMs=1.3 "
            + "prepareMs=0.4 instantiateMs=2.0 startMs=31.0 totalMs=40.0 termination=exited exit=0 outcome=verdict stdinBytes=120 "
            + "stdoutBytes=300 stderrBytes=0 capture=-");
        assertThat(record("endive").fields().keySet()).containsExactlyElementsOf(FIELDS);
        assertThat(record("endive").toString()).isEqualTo(line);
    }

    @Test
    void unknownsPrintAsADash() {
        TraceRecord none = new TraceRecord("0123456789ab", "pdf", null, null, "x", "unknown", -1, -1, -1, -1, 5, null, null, "unavailable",
            3, 0, 0, null, true);
        Map<String, Object> fields = none.fields();
        assertThat(fields).containsEntry("op", "-").containsEntry("abi", "-").containsEntry("slotWaitMs", "-").containsEntry("prepareMs", "-")
            .containsEntry("termination", "-").containsEntry("exit", "-").containsEntry("capture", "-");
        assertThat(none.withCapture("dropped").fields()).containsEntry("capture", "dropped");
    }

    @Test
    void noValueCanSplitTheLineOrForgeAField() {
        String hostile = "evil outcome=verdict\nrun=forged\u0000 \t=x";
        String line = record(hostile).line();
        assertThat(line).doesNotContain("\n").doesNotContain("\u0000").doesNotContain("\t");
        assertThat(keys(line)).containsExactlyElementsOf(FIELDS);
        assertThat(line).contains("engine=evil_outcome_verdict_run_forged____x");
        assertThat(TraceRecord.word("x".repeat(500))).hasSize(TraceRecord.MAX_WORD);
        assertThat(TraceRecord.word("café")).isEqualTo("caf_");
    }

    @Test
    void theModesTraceWhatTheySay() {
        assertThat(TraceMode.WORDS).containsExactly("off", "failures", "all");
        assertThat(Arrays.stream(TraceMode.values()).map(mode -> mode.traces(false) + "/" + mode.traces(true)).toList())
            .containsExactly("false/false", "false/true", "true/true");
        assertThat(TraceMode.of("all")).isEqualTo(TraceMode.ALL);
        assertThat(TraceMode.of("ALL")).isNull();
        assertThat(TraceMode.of(null)).isNull();
    }

    @Test
    void theDefaultTraceIsTheLogAndLinesHandsTheLine() {
        assertThat(RunTrace.log().describe()).contains(RunTrace.LOGGER);
        List<String> lines = new ArrayList<>();
        RunTrace.lines(lines::add).trace(record("endive"));
        assertThat(lines).containsExactly(record("endive").line());
        assertThat(new EngineInfo("endive", "1", "panama", "").id()).isEqualTo("endive");
    }
}
