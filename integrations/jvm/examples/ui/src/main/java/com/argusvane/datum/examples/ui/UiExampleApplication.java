package com.argusvane.datum.examples.ui;

import com.argusvane.datum.submissions.spi.AcceptedSubmission;
import com.argusvane.datum.submissions.spi.SubmissionHandler;
import com.argusvane.datum.submissions.spi.SubmissionReceipt;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;
import tools.jackson.databind.json.JsonMapper;

/**
 * Story two: the page asks the server for the form. {@code datum-spring-boot-starter-ui} serves the elements and
 * the glue, {@code datum/forms/contact.json} (on the class path) is the form, and this class only supplies what
 * the packages deliberately leave to the application: what to do with an accepted submission.
 */
@SpringBootApplication
public class UiExampleApplication {

    private static final Logger LOG = LoggerFactory.getLogger(UiExampleApplication.class);

    public static void main(String[] args) {
        SpringApplication.run(UiExampleApplication.class, args);
    }

    /**
     * The storage step. This one keeps nothing (a real application writes the row here, in a transaction) and
     * answers {@code CONTACT-0001}, {@code CONTACT-0002}, ... as the reference the form's notice shows.
     */
    @Bean
    SubmissionHandler contactHandler() {
        AtomicInteger sequence = new AtomicInteger();
        JsonMapper json = JsonMapper.builder().build();
        return (AcceptedSubmission submission) -> {
            String reference = "%s-%04d".formatted(submission.formKey().toUpperCase(java.util.Locale.ROOT), sequence.incrementAndGet());
            LOG.info("Accepted {} for {} (digest {}).", reference, submission.formKey(), submission.digest());
            var notice = json.createObjectNode();
            notice.put("title", "Thank you");
            notice.put("message", "Your message was received. Quote " + reference + " if you write to us again.");
            return new SubmissionReceipt(UUID.randomUUID().toString(), reference, notice);
        };
    }
}
