package com.argusvane.datum.pdf.web.mvc;

import com.argusvane.datum.pdf.api.PdfApi;
import com.argusvane.datum.submissions.spi.SubmissionRequest;
import com.argusvane.datum.springweb.mvc.DatumController;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.media.Content;
import io.swagger.v3.oas.annotations.media.Schema;
import io.swagger.v3.oas.annotations.parameters.RequestBody;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * {@code POST {api}/pdf/verify} on Spring MVC. Registered by the PDF auto-configuration only when
 * {@code datum.web.api.endpoints.verify} is on, so an application that turns it off may map that path itself.
 * The body is read raw (415 for a non-PDF type, the address limit, then the cap counted on the stream) and handed to the shared {@link PdfApi}; exceptions go through the Datum
 * advice because of {@link DatumController}.
 */
@RestController
@DatumController
@Tag(name = "datum-pdf", description = "PDF: render, fill, sign and verify.")
@RequestMapping("#{@datumPdfRoutes.api()}")
public class VerifyMvcController {

    private final PdfApi api;

    public VerifyMvcController(PdfApi api) {
        this.api = api;
    }

    @PostMapping("pdf/verify")
    @Operation(operationId = "verifyPdf", summary = "Check the signatures of a posted PDF", description = "Body: the PDF itself (application/pdf), up to datum.runtime.verify-max-bytes. Answers the verification report. Who may verify is the application's security (DatumRequestMatchers.pdfVerify()), or switch the route off.",
        requestBody = @RequestBody(required = true, content = @Content(mediaType = "application/pdf", schema = @Schema(type = "string", format = "binary"))),
        responses = {
            @ApiResponse(responseCode = "200", description = "The report {sha256, bytes, signatures, ..., trustPolicy}.",
                content = @Content(mediaType = "application/json", schema = @Schema(ref = "#/components/schemas/PdfVerifyReport"))),
            @ApiResponse(responseCode = "400", description = "Not a PDF (pdf.notAPdf, pdf.unreadable).",
                content = @Content(mediaType = "application/json", schema = @Schema(ref = "#/components/schemas/ErrorsBody"))),
            @ApiResponse(responseCode = "413", description = "Larger than the cap (bad_document).",
                content = @Content(mediaType = "application/json", schema = @Schema(ref = "#/components/schemas/ErrorsBody"))),
            @ApiResponse(responseCode = "415", description = "Not application/pdf.",
                content = @Content(mediaType = "application/json", schema = @Schema(ref = "#/components/schemas/ErrorsBody"))),
            @ApiResponse(responseCode = "429", description = "Too many requests (flood).",
                content = @Content(mediaType = "application/json", schema = @Schema(ref = "#/components/schemas/ErrorsBody"))),
            @ApiResponse(responseCode = "503", description = "PDF cannot be checked now (server.unavailable, server.busy with Retry-After; a run that gave no answer is wasm.execution_error or outcome_too_large, with none).",
                content = @Content(mediaType = "application/json", schema = @Schema(ref = "#/components/schemas/ErrorsBody")))})
    public ResponseEntity<byte[]> verify(HttpServletRequest request) {
        SubmissionRequest view = PdfMvcSupport.view(request);
        // 415, then the address limit, before a byte of the file is read.
        api.admitPdf(view);
        byte[] body;
        try {
            body = com.argusvane.datum.web.json.JsonBodies.read(request.getInputStream(), request.getContentLengthLong(), api.maxPdfBytes());
        } catch (java.io.IOException e) {
            throw new java.io.UncheckedIOException("The request body could not be read.", e);
        } catch (com.argusvane.datum.core.RequestTooLargeException e) {
            throw api.fileTooLarge();
        }
        return PdfMvcSupport.entity(api.verify(body, view));
    }
}
