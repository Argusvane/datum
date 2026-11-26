package com.argusvane.datum.examples.webfluxpdf;

import com.argusvane.datum.submissions.spi.AcceptedSubmission;
import com.argusvane.datum.submissions.spi.SubmissionHandler;
import com.argusvane.datum.submissions.spi.SubmissionReceipt;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;

/**
 * Story four: a WebFlux application that prints, fills, seals and verifies PDFs of a form's answers.
 * {@code datum-spring-boot-starter-pdf} adds {@code POST /api/pdf}, {@code /api/pdf/fill}, {@code /api/pdf/sign},
 * {@code /api/pdf/verify} and {@code GET /api/server/certificate} beside the submissions endpoints, and the
 * {@code PdfService} this application's {@link ReceiptPdfController} prints a stored submission with. This class holds
 * the one thing the packages leave to the application: what to do with an accepted submission. Here it is kept in
 * memory (a real application writes the row) so the receipt can be printed back.
 */
@SpringBootApplication
public class PdfExampleApplication {

    private static final Logger LOG = LoggerFactory.getLogger(PdfExampleApplication.class);

    public static void main(String[] args) {
        SpringApplication.run(PdfExampleApplication.class, args);
    }

    /** What the storage step kept, by the id the receipt carries. */
    @Bean
    Map<String, AcceptedSubmission> storedSubmissions() {
        return new ConcurrentHashMap<>();
    }

    @Bean
    SubmissionHandler storingHandler(Map<String, AcceptedSubmission> stored) {
        AtomicInteger sequence = new AtomicInteger();
        return (AcceptedSubmission submission) -> {
            String id = UUID.randomUUID().toString();
            String reference = "REQ-%04d".formatted(sequence.incrementAndGet());
            stored.put(id, submission);
            LOG.info("Accepted {} for {} (digest {}).", reference, submission.formKey(), submission.digest());
            return new SubmissionReceipt(id, reference, null);
        };
    }
}
