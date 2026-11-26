package com.argusvane.datum.submissions.spring;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.core.DatumStartupCheck;
import com.argusvane.datum.submissions.receiver.LoggingSubmissionHandler;
import com.argusvane.datum.submissions.spi.AcceptedSubmission;
import com.argusvane.datum.submissions.spi.SubmissionHandler;
import com.argusvane.datum.submissions.spi.SubmissionReceipt;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.support.DefaultListableBeanFactory;

/**
 * The start-up WARN for the handler that stores nothing is written whenever the logging handler is among
 * the handlers, not only when it is the only one ({@code getIfUnique} fell silent with two candidates).
 */
class SubmissionsStartupChecksTest {

    private static SubmissionHandler storing() {
        return new SubmissionHandler() {
            @Override
            public SubmissionReceipt handle(AcceptedSubmission submission) {
                return new SubmissionReceipt("1", null, null);
            }
        };
    }

    private static DatumStartupCheck check(SubmissionHandler... handlers) {
        DefaultListableBeanFactory beans = new DefaultListableBeanFactory();
        for (int i = 0; i < handlers.length; i++) {
            beans.registerSingleton("handler" + i, handlers[i]);
        }
        return new DatumSubmissionsAutoConfiguration().datumSubmissionHandlerStartupCheck(beans.getBeanProvider(SubmissionHandler.class));
    }

    @Test
    void theLoggingHandlerAloneIsReported() {
        assertThat(check(new LoggingSubmissionHandler()).check()).singleElement().satisfies(notice -> assertThat(notice.message()).contains("NOT STORED"));
    }

    @Test
    void anApplicationsStoringHandlerAloneIsSilent() {
        assertThat(check(storing()).check()).isEmpty();
    }

    @Test
    void theLoggingHandlerBesideAnotherIsStillReported() {
        assertThat(check(storing(), new LoggingSubmissionHandler()).check()).hasSize(1);
    }
}
