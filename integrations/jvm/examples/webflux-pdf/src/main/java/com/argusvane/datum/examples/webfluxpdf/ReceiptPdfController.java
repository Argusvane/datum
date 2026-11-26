package com.argusvane.datum.examples.webfluxpdf;

import com.argusvane.datum.forms.DefinitionService;
import com.argusvane.datum.pdf.PdfOptions;
import com.argusvane.datum.pdf.PdfResult;
import com.argusvane.datum.pdf.PdfService;
import com.argusvane.datum.submissions.spi.AcceptedSubmission;
import java.util.Map;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

/**
 * The application's own PDF: a stored submission printed back as the person's receipt. The answers were validated by
 * the server and stored by this application, so the document is one the application issues: it is sealed with the
 * server's key under the preset ({@code datum.pdf.seal.*}), where the PDF of merely posted answers
 * ({@code POST /api/pdf}) is not. A render takes seconds and blocks, so it runs off the event loop.
 */
@RestController
class ReceiptPdfController {

    private final PdfService pdf;
    private final DefinitionService definitions;
    private final Map<String, AcceptedSubmission> stored;

    ReceiptPdfController(PdfService pdf, DefinitionService definitions, Map<String, AcceptedSubmission> stored) {
        this.pdf = pdf;
        this.definitions = definitions;
        this.stored = stored;
    }

    @GetMapping(value = "/receipts/{id}.pdf")
    Mono<ResponseEntity<byte[]>> receipt(@PathVariable String id) {
        AcceptedSubmission submission = stored.get(id);
        if (submission == null) {
            return Mono.just(ResponseEntity.notFound().build());
        }
        return Mono.fromCallable(() -> {
            // The form as it is now; a real application prints the version the record names (the definition snapshot).
            PdfResult result = pdf.renderSubmission(definitions.current(submission.formKey()).definition(), submission.values(),
                submission.locale(), null, PdfOptions.defaults().withFormKey(submission.formKey()));
            ResponseEntity.BodyBuilder reply = ResponseEntity.ok().contentType(MediaType.APPLICATION_PDF)
                .header(HttpHeaders.CONTENT_DISPOSITION, "inline; filename=\"receipt.pdf\"")
                .header("X-Page-Count", String.valueOf(result.pageCount()))
                .header("X-Sealed", String.valueOf(result.signed()))
                .header("X-Timestamped", String.valueOf(result.seal() != null && result.seal().timestamped()));
            return reply.body(result.bytes());
        }).subscribeOn(Schedulers.boundedElastic());
    }
}
