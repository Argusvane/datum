package com.argusvane.datum.pdf.web.mvc;

import com.argusvane.datum.pdf.api.PdfApi;
import com.argusvane.datum.submissions.spi.SubmissionRequest;
import com.argusvane.datum.springweb.mvc.DatumController;
import com.argusvane.datum.springweb.mvc.MvcBodies;
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
 * {@code POST {api}/pdf} on Spring MVC. Registered by the PDF auto-configuration only when
 * {@code datum.web.api.endpoints.pdf} is on, so an application that turns it off may map that path itself.
 * The body is read raw (415, the address limit, then the cap counted on the stream) and handed to the shared {@link PdfApi}; exceptions go through the Datum
 * advice because of {@link DatumController}.
 */
@RestController
@DatumController
@Tag(name = "datum-pdf", description = "PDF: render, fill, sign and verify.")
@RequestMapping("#{@datumPdfRoutes.api()}")
public class PdfMvcController {

    private final PdfApi api;

    public PdfMvcController(PdfApi api) {
        this.api = api;
    }

    @PostMapping("pdf")
    @Operation(operationId = "renderPdf", summary = "The form's PDF of posted answers", description = "Body {document, layoutId?, locale?, options?}: the answers are judged first (the receiver's dry run, nothing kept) and the PDF prints the sanitized values. Sealed with a throwaway test certificate unless datum.pdf.seal.posted-answers is on. Headers: X-Page-Count, X-Datum-Layout, X-Datum-Pdf-Theme (the PDF theme the route's binding suggests), X-Signed-By, X-Signature-Field, X-Timestamped.",
        requestBody = @RequestBody(required = true, content = @Content(mediaType = "application/json", schema = @Schema(type = "object"))),
        responses = {
            @ApiResponse(responseCode = "200", description = "The PDF (application/pdf).",
                content = @Content(mediaType = "application/pdf", schema = @Schema(type = "string", format = "binary"))),
            @ApiResponse(responseCode = "400", description = "Malformed request (bad_request, bad_document).",
                content = @Content(mediaType = "application/json", schema = @Schema(ref = "#/components/schemas/ErrorsBody"))),
            @ApiResponse(responseCode = "403", description = "Refused by the application's security (access.denied when it installs DatumSecurityResponses).",
                content = @Content(mediaType = "application/json", schema = @Schema(ref = "#/components/schemas/ErrorsBody"))),
            @ApiResponse(responseCode = "404", description = "No such form or layout (form.notFound, layout.notFound).",
                content = @Content(mediaType = "application/json", schema = @Schema(ref = "#/components/schemas/ErrorsBody"))),
            @ApiResponse(responseCode = "422", description = "The server does not accept the answers (errors).",
                content = @Content(mediaType = "application/json", schema = @Schema(ref = "#/components/schemas/ErrorsBody"))),
            @ApiResponse(responseCode = "429", description = "Too many requests (flood).",
                content = @Content(mediaType = "application/json", schema = @Schema(ref = "#/components/schemas/ErrorsBody"))),
            @ApiResponse(responseCode = "503", description = "PDF cannot be made now (server.unavailable, server.busy with Retry-After; a run that gave no answer is wasm.execution_error, outcome_too_large or, for a form nested too deep, definition.tooDeep, none with Retry-After).",
                content = @Content(mediaType = "application/json", schema = @Schema(ref = "#/components/schemas/ErrorsBody"))),
            @ApiResponse(responseCode = "413", description = "Body too large (bad_document).",
                content = @Content(mediaType = "application/json", schema = @Schema(ref = "#/components/schemas/ErrorsBody"))),
            @ApiResponse(responseCode = "415", description = "Not JSON.",
                content = @Content(mediaType = "application/json", schema = @Schema(ref = "#/components/schemas/ErrorsBody")))})
    public ResponseEntity<byte[]> pdf(HttpServletRequest request) {
        SubmissionRequest view = PdfMvcSupport.view(request);
        // 415, then the address limit, before a byte of the body is read: a body that never parses is counted too.
        api.admitJson(view);
        byte[] body = MvcBodies.readJsonBytes(request, api.maxBodyBytes());
        return PdfMvcSupport.entity(api.pdf(body, view));
    }
}
