package com.argusvane.datum.sandbox.protocol;

import static com.argusvane.datum.sandbox.protocol.Fixtures.NONCE;
import static com.argusvane.datum.sandbox.protocol.Fixtures.begin;
import static com.argusvane.datum.sandbox.protocol.Fixtures.end;
import static com.argusvane.datum.sandbox.protocol.Fixtures.started;
import static com.argusvane.datum.sandbox.protocol.Fixtures.utf8;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.sandbox.protocol.SandboxException.Reason;
import com.argusvane.datum.sandbox.wasi.Budget;
import com.argusvane.datum.sandbox.wasi.RunOutput;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;

/**
 * The answer frame: only a framed answer is an outcome, bytes outside the frame refuse the
 * run, and the 29-case table of framed-golden.json ({@link FrameGolden}).
 */
class FrameTest {

    private static final Budget BUDGET = ProgramLimits.defaults().validationBudget();

    @Test
    void markersCarryTheNonceAndTheKind() {
        assertThat(Frame.marker(NONCE, "started")).isEqualTo("@@datum:" + NONCE + ":started@@");
        assertThat(Frame.marker(NONCE, "begin")).isEqualTo("@@datum:" + NONCE + ":begin@@");
        assertThat(Frame.marker(NONCE, "end")).isEqualTo("@@datum:" + NONCE + ":end@@");
    }

    /**
     * Every case of the frame table, byte for byte: the inputs {@link FrameGolden} builds are the golden's, and so is
     * every answer. A difference is a change of the frame rule, never a reason to regenerate the file.
     */
    @Test
    void framedMatchesTheFrameTableByteForByte() {
        JsonNode golden = Fixtures.json("framed-golden.json");
        assertThat(golden).isEqualTo(FrameGolden.golden());
        String nonce = golden.get("nonce").stringValue();
        assertThat(golden.get("cases").size()).isEqualTo(29);
        for (JsonNode row : golden.get("cases").values()) {
            String label = row.get("label").stringValue();
            byte[] stdout = Base64.getDecoder().decode(row.get("stdoutBase64").stringValue());
            byte[] framed = Frame.framed(stdout, nonce);
            if (row.get("framed").isNull()) {
                assertThat(framed).as(label).isNull();
            } else {
                assertThat(framed).as(label).isEqualTo(Base64.getDecoder().decode(row.get("framed").stringValue()));
            }
            assertThat(Frame.hasStrayOutput(stdout, nonce)).as(label + " (stray)").isEqualTo(row.get("stray").booleanValue());
        }
    }

    /**
     * The ByteBuffer overloads read from the buffer's position, as the byte[] ones read from 0: a view whose position is not 0
     * (a caller that consumed a prefix, or a slice of a larger buffer) is stdout from there on, not from the array's start.
     */
    @Test
    void aBufferViewIsReadFromItsPositionNotFromZero() {
        byte[] frame = Fixtures.frame(NONCE, "{\"ok\":true}").getBytes(StandardCharsets.UTF_8);
        byte[] prefix = "ignored bytes before the view\n".getBytes(StandardCharsets.UTF_8);
        byte[] all = new byte[prefix.length + frame.length];
        System.arraycopy(prefix, 0, all, 0, prefix.length);
        System.arraycopy(frame, 0, all, prefix.length, frame.length);
        java.nio.ByteBuffer view = java.nio.ByteBuffer.wrap(all).asReadOnlyBuffer();
        view.position(prefix.length);

        assertThat(Frame.framed(view, NONCE)).isEqualTo("{\"ok\":true}".getBytes(StandardCharsets.UTF_8));
        assertThat(Frame.hasStrayOutput(view, NONCE)).isTrue();
        assertThat(Frame.started(view, NONCE)).isTrue();
        assertThat(view.position()).as("the caller's buffer is left where it was").isEqualTo(prefix.length);

        // From position 0 the same bytes are not a frame (the prefix is stray output): the position is what decides.
        java.nio.ByteBuffer whole = java.nio.ByteBuffer.wrap(all).asReadOnlyBuffer();
        assertThat(Frame.framed(whole, NONCE)).isNull();
        // And a position past the started marker finds no start.
        java.nio.ByteBuffer late = java.nio.ByteBuffer.wrap(all).asReadOnlyBuffer();
        late.position(prefix.length + started().length() + 1);
        assertThat(Frame.started(late, NONCE)).isFalse();
    }

    /** Only an exit-0 run with exactly one framed answer is an answer. */
    @Test
    void onlyFramedAnswersAreOutcomes() {
        String stdout = started() + "\n" + begin() + "\n" + "{\"errors\":[]}" + "\n" + end() + "\n";
        assertThat(new String(RunClassifier.sandboxAnswer(RunOutput.exited(0, utf8(stdout), null), NONCE, BUDGET), StandardCharsets.UTF_8))
            .isEqualTo("{\"errors\":[]}");

        // A guest that printed its own verdict and exited 0 (the old attack).
        String forged = "{\"errors\":[],\"values\":{\"name\":\"forged\"},\"digest\":\"x\"}\n";
        for (String unframed : new String[] {forged, started() + "\n" + forged, "", started() + "\n"}) {
            assertThatThrownBy(() -> RunClassifier.sandboxAnswer(RunOutput.exited(0, utf8(unframed), null), NONCE, BUDGET))
                .isInstanceOfSatisfying(SandboxException.class, e -> assertThat(e.reason()).isEqualTo(Reason.NO_OUTCOME));
        }
        // Markers of another nonce (a guess) do not count either.
        String other = Frame.marker("f".repeat(32), "begin") + "\n{\"errors\":[]}\n" + Frame.marker("f".repeat(32), "end");
        assertThat(Frame.framed(other, NONCE)).isNull();
        // Two answers, an end before a begin, or a lone marker: refused.
        assertThat(Frame.framed(stdout + begin() + "\n{}\n" + end(), NONCE)).isNull();
        assertThat(Frame.framed(end() + "\n{}\n" + begin(), NONCE)).isNull();
        assertThat(Frame.framed(begin() + "\n{}\n", NONCE)).isNull();
        // The frame needs the started marker before the begin marker.
        assertThat(Frame.framed(begin() + "\n{}\n" + end() + "\n", NONCE)).isNull();
        assertThat(Frame.framed(begin() + "\n{}\n" + end() + "\n" + started(), NONCE)).isNull();
        // Whitespace around the markers is fine.
        assertThat(Frame.framed("\n " + started() + " \r\n\n" + begin() + "\n{}\n" + end() + " \n\n", NONCE)).isEqualTo("{}");
    }

    /** Bytes outside the single frame refuse the run, even on exit 0. */
    @Test
    void bytesOutsideTheFrameRefuseTheRun() {
        String frame = started() + "\n" + begin() + "\n" + "{\"errors\":[]}" + "\n" + end() + "\n";
        assertThat(Frame.framed(frame, NONCE)).isEqualTo("{\"errors\":[]}");
        Map<String, String> cases = new LinkedHashMap<>();
        cases.put("after the end", frame + "INJECTED-LINE\n");
        cases.put("before the started marker", "INJECTED-LINE\n" + frame);
        cases.put("between started and begin", started() + "\nINJECTED\n" + begin() + "\n{}\n" + end() + "\n");
        cases.put("glued to the end marker", started() + "\n" + begin() + "\n{}\n" + end() + "x");
        cases.put("a second started marker", frame + started() + "\n");
        cases.put("a second frame", frame + frame);
        cases.forEach((label, stdout) -> {
            assertThat(Frame.framed(stdout, NONCE)).as(label).isNull();
            assertThatThrownBy(() -> RunClassifier.sandboxAnswer(RunOutput.exited(0, utf8(stdout), null), NONCE, BUDGET))
                .as(label)
                .isInstanceOfSatisfying(SandboxException.class, e -> {
                    assertThat(e.reason()).isIn(Reason.FRAME, Reason.NO_OUTCOME);
                    assertThat(e.code()).isEqualTo("wasm.execution_error");
                });
        });
        // The message tells a stray byte from a missing answer.
        assertThatThrownBy(() -> RunClassifier.sandboxAnswer(RunOutput.exited(0, utf8(frame + "INJECTED-LINE\n"), null), NONCE, BUDGET))
            .isInstanceOfSatisfying(SandboxException.class, e -> {
                assertThat(e.reason()).isEqualTo(Reason.FRAME);
                assertThat(e.getMessage()).contains("outside its answer frame");
            });
    }

    /**
     * The frame's whitespace is JSON's (space, tab, line feed, carriage return), not Java's trim(): a NUL, a vertical
     * tab, a form feed or a no-break space outside the frame is a byte run.js never prints and refuses the run.
     */
    @Test
    void whitespaceIsJsonsWhitespace() {
        String frame = started() + "\n" + begin() + "\n{}\n" + end();
        assertThat(Frame.framed("\t \r\n" + frame + "\r\n \t", NONCE)).isEqualTo("{}");
        assertThat(Frame.framed(started() + "\n" + begin() + "\r\n\t {} \t\r\n" + end(), NONCE)).isEqualTo("{}");
        for (String stray : List.of("\0", "\u000B", "\f")) {
            assertThat(Frame.framed(stray + frame, NONCE)).as("before: " + (int) stray.charAt(0)).isNull();
            assertThat(Frame.framed(frame + stray, NONCE)).as("after: " + (int) stray.charAt(0)).isNull();
            assertThat(Frame.framed(started() + stray + begin() + "\n{}\n" + end(), NONCE)).as("between: " + (int) stray.charAt(0)).isNull();
            assertThat(Frame.framed(frame + "\n" + stray + stray + "\n", NONCE)).as("a module's write after the frame").isNull();
        }
        assertThat(Frame.framed("\f" + frame, NONCE)).isNull();
        assertThat(Frame.framed(frame + " ", NONCE)).isNull();
        assertThat(Frame.framed(frame + " ", NONCE)).isNull();
    }

    /** The views a run's output gives judge exactly as the byte arrays do, and the answer is the only thing copied. */
    @Test
    void aReadOnlyViewIsJudgedAsTheBytesAre() {
        String frame = started() + "\n" + begin() + "\n{\"a\":1}\n" + end() + "\n";
        java.nio.ByteBuffer view = java.nio.ByteBuffer.wrap(utf8(frame)).asReadOnlyBuffer();
        assertThat(new String(Frame.framed(view, NONCE), StandardCharsets.UTF_8)).isEqualTo("{\"a\":1}");
        assertThat(view.position()).as("read by absolute index, the view is not consumed").isZero();
        assertThat(Frame.started(view, NONCE)).isTrue();
        assertThat(Frame.hasStrayOutput(view, NONCE)).isTrue();
        java.nio.ByteBuffer stray = java.nio.ByteBuffer.wrap(utf8("x" + frame)).asReadOnlyBuffer();
        assertThat(Frame.framed(stray, NONCE)).isNull();
        assertThat(Frame.hasStrayOutput(stray, NONCE)).isTrue();
    }

    @Test
    void markerCountIsNonOverlapping() {
        assertThat(Frame.count(utf8("aaaa"), utf8("aa"))).isEqualTo(2);
        assertThat(Frame.count(utf8("aaa"), utf8("aa"))).isEqualTo(1);
        assertThat(Frame.count(utf8(""), utf8("aa"))).isZero();
    }

    @Test
    void startedIsAnywhereInStdout() {
        assertThat(Frame.started(utf8("x" + started() + "y"), NONCE)).isTrue();
        assertThat(Frame.started(utf8(Frame.marker("f".repeat(32), "started")), NONCE)).isFalse();
    }
}
