package com.argusvane.datum.examples.submissions;

import com.argusvane.datum.submissions.spi.AcceptedSubmission;
import com.argusvane.datum.submissions.spi.SubmissionHandler;
import com.argusvane.datum.submissions.spi.SubmissionReceipt;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;

/**
 * Story one: the server validates what a form delivers. {@code datum-spring-boot-starter-submissions} runs the
 * form's own rules in the sandbox on every {@code POST /api/submissions}; the form is a file on the class path
 * ({@code datum/forms/endpoint-fixture.definition.json}, the security suite's fixture, so that
 * {@code datum-security-check --endpoint} can attack this very application). This class supplies the one thing
 * the packages leave to the application: what to do with an accepted submission. {@link QueuedSubmissions} is the same
 * pipeline without HTTP: documents from an in-memory queue, judged by the same {@code SubmissionService} on channel
 * {@code bus}.
 */
@SpringBootApplication
public class SubmissionsExampleApplication {

    private static final Logger LOG = LoggerFactory.getLogger(SubmissionsExampleApplication.class);

    public static void main(String[] args) {
        SpringApplication.run(SubmissionsExampleApplication.class, args);
    }

    /**
     * The storage step. This one keeps nothing (a real application writes the row here, in a transaction, under a
     * unique key on the form and {@code submission.submissionKey()}, and returns its id) and answers {@code SUB-0001},
     * {@code SUB-0002}, ... as the reference.
     */
    @Bean
    SubmissionHandler loggingHandler() {
        AtomicInteger sequence = new AtomicInteger();
        return (AcceptedSubmission submission) -> {
            String reference = "SUB-%04d".formatted(sequence.incrementAndGet());
            LOG.info("Accepted {} for {} on {} (digest {}, {} values).", reference, submission.formKey().toUpperCase(Locale.ROOT),
                submission.channel(), submission.digest(), submission.values().size());
            return new SubmissionReceipt(UUID.randomUUID().toString(), reference, null);
        };
    }
}
