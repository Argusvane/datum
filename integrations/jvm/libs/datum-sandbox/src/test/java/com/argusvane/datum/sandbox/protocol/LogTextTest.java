package com.argusvane.datum.sandbox.protocol;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.sandbox.protocol.SandboxException.Reason;
import org.junit.jupiter.api.Test;

/** A run's words on one log line, and the short form an ERROR line carries. */
class LogTextTest {

    @Test
    void aShortTextIsOnlyEscaped() {
        assertThat(LogText.summary("plain")).isEqualTo("plain");
        assertThat(LogText.summary("a\r\nb\u001b[2Kc")).isEqualTo("a\\r\\nb\\u001b[2Kc");
        assertThat(LogText.summary("x".repeat(LogText.SUMMARY_CHARS))).isEqualTo("x".repeat(LogText.SUMMARY_CHARS));
    }

    @Test
    void aLongTextKeepsItsStartAndSaysHowMuchWasLeftOut() {
        String text = "y".repeat(LogText.SUMMARY_CHARS) + "\nsecret";
        assertThat(LogText.summary(text)).isEqualTo("y".repeat(LogText.SUMMARY_CHARS) + " ... (7 more characters)");
    }

    /** The cut is made before the escaping, so an escape is never split, nor a surrogate pair. */
    @Test
    void theCutSplitsNeitherAnEscapeNorASurrogatePair() {
        String escapes = "\u001b".repeat(LogText.SUMMARY_CHARS + 10);
        assertThat(LogText.summary(escapes)).startsWith("\\u001b".repeat(LogText.SUMMARY_CHARS) + " ... (10 more");
        String pair = "z".repeat(LogText.SUMMARY_CHARS - 1) + "😀" + "tail";
        assertThat(LogText.summary(pair)).isEqualTo("z".repeat(LogText.SUMMARY_CHARS - 1) + " ... (6 more characters)");
    }

    @Test
    void aFailedRunsStderrReachesTheLogEscaped() {
        SandboxException e = new SandboxException(Reason.THREW, "The sandbox program threw.", "Error: one\nline two\u009b" + "q".repeat(500));
        assertThat(e.stderr()).as("kept as it was, for the capture").contains("\n");
        assertThat(e.stderrSummary()).startsWith("Error: one\\nline two\\u009b").endsWith("(" + (20 + 500 - LogText.SUMMARY_CHARS) + " more characters)");
        assertThat(e.stderrLine()).isEqualTo("Error: one\\nline two\\u009b" + "q".repeat(500));
        assertThat(new SandboxException(Reason.TRAP, "The sandbox program trapped.").stderrSummary()).isEmpty();
    }
}
