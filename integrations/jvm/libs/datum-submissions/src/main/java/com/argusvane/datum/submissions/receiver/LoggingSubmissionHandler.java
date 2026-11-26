package com.argusvane.datum.submissions.receiver;

import com.argusvane.datum.core.DatumStartupCheck;
import com.argusvane.datum.submissions.spi.AcceptedSubmission;
import com.argusvane.datum.submissions.spi.SubmissionHandler;
import com.argusvane.datum.submissions.spi.SubmissionReceipt;
import java.util.List;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The default {@link SubmissionHandler}: stores nothing. It logs each accepted submission (form, digest, never
 * the answers) and answers a fresh UUID, so a new application sees the whole flow work before it writes its
 * own handler. {@link #startupCheck} says so in one WARN at start when it is the handler in use (a start-up check since
 * integrations/jvm/README.md "Libraries and bindings": the WARN was written by this constructor before).
 */
public final class LoggingSubmissionHandler implements SubmissionHandler {

    private static final Logger LOG = LoggerFactory.getLogger(LoggingSubmissionHandler.class);

    /** The WARN when {@code handler} is this one (no handler of the application's own), else nothing. */
    public static DatumStartupCheck startupCheck(SubmissionHandler handler) {
        return () -> handler instanceof LoggingSubmissionHandler
            ? List.of(DatumStartupCheck.Notice.warn(LoggingSubmissionHandler.class, "Datum: no SubmissionHandler bean is defined, so "
                + "accepted submissions are logged and NOT STORED. Define a SubmissionHandler bean that stores them."))
            : List.of();
    }

    @Override
    public SubmissionReceipt handle(AcceptedSubmission submission) {
        String id = UUID.randomUUID().toString();
        LOG.info("Datum submission {} to form {} accepted (digest {}), not stored: no SubmissionHandler is defined.", id,
            submission.formKey(), submission.digest());
        return new SubmissionReceipt(id, null, null);
    }
}
