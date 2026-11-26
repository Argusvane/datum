package com.argusvane.datum.examples.passkeys;

import com.argusvane.datum.submissions.spi.AcceptedSubmission;
import com.argusvane.datum.submissions.spi.SubmissionHandler;
import com.argusvane.datum.submissions.spi.SubmissionReceipt;
import com.argusvane.datum.webauthn.events.PasskeyRegisteredEvent;
import com.argusvane.datum.webauthn.events.SubmissionSignatureVerifiedEvent;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;
import org.springframework.context.event.EventListener;

/**
 * Passkey-signed submissions. {@code datum-spring-boot-starter-webauthn} brings the passkey endpoints
 * ({@code /api/webauthn/*}), the verifier and the receiver's signature check; {@code datum.webauthn.forms.petition.mode=required}
 * makes the form sign. What the packages leave to the application is here: who the person is ({@link SecurityConfiguration}),
 * where passkeys live (the H2 tables Flyway created from Datum's V400 script) and what to do with a signed submission,
 * which arrives only once its signature verified and its digest was claimed.
 */
@SpringBootApplication
public class PasskeysExampleApplication {

    private static final Logger LOG = LoggerFactory.getLogger(PasskeysExampleApplication.class);

    public static void main(String[] args) {
        SpringApplication.run(PasskeysExampleApplication.class, args);
    }

    /** The storage step: keeps nothing and answers {@code PETITION-0001}, ... as the reference. */
    @Bean
    SubmissionHandler petitionHandler() {
        AtomicInteger sequence = new AtomicInteger();
        return (AcceptedSubmission submission) -> {
            String reference = "%s-%04d".formatted(submission.formKey().toUpperCase(Locale.ROOT), sequence.incrementAndGet());
            LOG.info("Accepted {} (digest {}, signature {}).", reference, submission.digest(), submission.signature().status());
            return new SubmissionReceipt(UUID.randomUUID().toString(), reference, null);
        };
    }

    /** Events the module publishes: never the passkey's name, which may be an answer. */
    @EventListener
    void registered(PasskeyRegisteredEvent event) {
        LOG.info("Passkey {} registered (form {}, owner {}).", event.credentialId(), event.formKey(), event.owner());
    }

    @EventListener
    void verified(SubmissionSignatureVerifiedEvent event) {
        LOG.info("Signature on {} judged {} (passkey {}).", event.formKey(), event.status(), event.credentialId());
    }
}
