package com.argusvane.datum.submissions.receiver;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.core.DatumStartupCheck;
import com.argusvane.datum.submissions.spi.SubmissionHandler;
import com.argusvane.datum.submissions.spi.SubmissionReceipt;
import org.junit.jupiter.api.Test;

/** The "NOT STORED" WARN is a start-up check over the handler in use (integrations/jvm/README.md "Libraries and bindings"). */
class LoggingSubmissionHandlerStartupTest {

    @Test
    void theDefaultHandlerIsWarnedAboutAndAnApplicationHandlerIsNot() {
        assertThat(LoggingSubmissionHandler.startupCheck(new LoggingSubmissionHandler()).check())
            .singleElement()
            .satisfies(notice -> {
                assertThat(notice.level()).isEqualTo(DatumStartupCheck.Level.WARN);
                assertThat(notice.logger()).isEqualTo(LoggingSubmissionHandler.class.getName());
                assertThat(notice.message()).contains("NOT STORED");
            });
        SubmissionHandler own = submission -> new SubmissionReceipt("1", null, null);
        assertThat(LoggingSubmissionHandler.startupCheck(own).check()).isEmpty();
        assertThat(LoggingSubmissionHandler.startupCheck(null).check()).as("no unique handler: nothing claimed").isEmpty();
    }
}
