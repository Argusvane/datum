package com.argusvane.datum.submissions.service;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.sandbox.protocol.LogText;
import com.argusvane.datum.sandbox.protocol.SandboxException;
import com.argusvane.datum.sandbox.protocol.SandboxException.Reason;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.slf4j.Marker;
import org.slf4j.event.Level;
import org.slf4j.helpers.LegacyAbstractLogger;
import org.slf4j.helpers.MessageFormatter;

/** What a failed run leaves in the log: the guest's stderr escaped onto one line, only its start at ERROR. */
class RunFailureLogTest {

    /** A thrown message that quotes a submitted value, forges a log line and rewrites the terminal's line. */
    private static final String STDERR = "Error: bad value 'jane@example.org'\r\n[INFO] admin login succeeded\u001b[2K\u001b[1G"
        + "\u0085\u009b" + "x".repeat(10_000);

    @Test
    void theErrorLineCarriesTheEscapedStartAndDebugTheEscapedWhole() {
        Recorder log = new Recorder(true);
        SubmissionService.logRunFailure(log, "contact", new SandboxException(Reason.THREW, "The sandbox program threw.", STDERR));
        assertThat(log.lines).hasSize(2);
        Line error = log.lines.get(0);
        assertThat(error.level()).isEqualTo(Level.ERROR);
        assertThat(error.text()).startsWith("Sandbox run for contact failed (THREW): The sandbox program threw. Error: bad value")
            .contains("\\r\\n[INFO] admin").contains("\\u001b[2K").contains("\\u0085\\u009b")
            .contains("more characters)");
        assertThat(error.text().length()).isLessThan(LogText.SUMMARY_CHARS + 200);
        Line debug = log.lines.get(1);
        assertThat(debug.level()).isEqualTo(Level.DEBUG);
        assertThat(debug.text()).contains("x".repeat(10_000)).endsWith("x");
        for (Line line : log.lines) {
            assertThat(line.text()).doesNotContain("\r", "\n", "\u001b", "\u0085", "\u009b");
        }
    }

    @Test
    void withoutDebugOnlyTheErrorLineIsWritten() {
        Recorder log = new Recorder(false);
        SubmissionService.logRunFailure(log, "contact", new SandboxException(Reason.TRAP, "The sandbox program trapped.", "short"));
        assertThat(log.lines).singleElement().satisfies(line -> {
            assertThat(line.level()).isEqualTo(Level.ERROR);
            assertThat(line.text()).isEqualTo("Sandbox run for contact failed (TRAP): The sandbox program trapped. short");
        });
    }

    @Test
    void aBusyRefusalIsInfoWithoutStderr() {
        Recorder log = new Recorder(true);
        SubmissionService.logRunFailure(log, "contact", new SandboxException(Reason.BUSY, "Every run slot is taken.", STDERR));
        assertThat(log.lines).singleElement().satisfies(line -> {
            assertThat(line.level()).isEqualTo(Level.INFO);
            assertThat(line.text()).isEqualTo("Sandbox run for contact failed (BUSY): Every run slot is taken.");
        });
    }

    private record Line(Level level, String text) {
    }

    /** A logger that keeps what it is given, formatted as SLF4J formats it. */
    private static final class Recorder extends LegacyAbstractLogger {

        private static final long serialVersionUID = 1L;

        private final boolean debug;
        final List<Line> lines = new ArrayList<>();

        Recorder(boolean debug) {
            this.debug = debug;
            this.name = "test";
        }

        @Override
        public boolean isTraceEnabled() {
            return false;
        }

        @Override
        public boolean isDebugEnabled() {
            return debug;
        }

        @Override
        public boolean isInfoEnabled() {
            return true;
        }

        @Override
        public boolean isWarnEnabled() {
            return true;
        }

        @Override
        public boolean isErrorEnabled() {
            return true;
        }

        @Override
        protected String getFullyQualifiedCallerName() {
            return null;
        }

        @Override
        protected void handleNormalizedLoggingCall(Level level, Marker marker, String pattern, Object[] arguments, Throwable throwable) {
            lines.add(new Line(level, MessageFormatter.basicArrayFormat(pattern, arguments)));
        }
    }
}
