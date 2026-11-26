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
 * {@code POST {api}/pdf/sign} on Spring MVC. Registered by the PDF auto-configuration only when
 * {@code datum.web.api.endpoints.sign} is on, so an application that turns it off may map that path itself.
 * The body is read raw (415, the address limit, then the cap counted on the stream) and handed to the shared {@link PdfApi}; exceptions go through the Datum
 * advice because of {@link DatumController}.
 */
@RestController
@DatumController
@Tag(name = "datum-pdf", description = "PDF: render, fill, sign and verify.")
@RequestMapping("#{@datumPdfRoutes.api()}")
public class SignMvcController {

    private final PdfApi api;

    public SignMvcController(PdfApi api) {
        this.api = api;
    }

    @PostMapping("pdf/sign")
    @Operation(operationId = "signPdf", summary = "The form's PDF of posted answers, always sealed", description = "As POST /pdf, but always sealed: with a throwaway test certificate unless datum.pdf.seal.posted-answers is on. 503 when the server has no signing key.",
        requestBody = @RequestBody(required = true, content = @Content(mediaType = "application/json", schema = @Schema(type = "object"))),
        responses = {
            @ApiResponse(responseCode = "200", description = "The sealed PDF (application/pdf).",
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
            @ApiResponse(responseCode = "503", description = "No signing key, or PDF cannot be made now (server.unavailable, server.busy with Retry-After; a run that gave no answer is wasm.execution_error, outcome_too_large or, for a form nested too deep, definition.tooDeep, none with Retry-After).",
                content = @Content(mediaType = "application/json", schema = @Schema(ref = "#/components/schemas/ErrorsBody"))),
            @ApiResponse(responseCode = "413", description = "Body too large (bad_document).",
                content = @Content(mediaType = "application/json", schema = @Schema(ref = "#/components/schemas/ErrorsBody"))),
            @ApiResponse(responseCode = "415", description = "Not JSON.",
                content = @Content(mediaType = "application/json", schema = @Schema(ref = "#/components/schemas/ErrorsBody")))})
    public ResponseEntity<byte[]> sign(HttpServletRequest request) {
        SubmissionRequest view = PdfMvcSupport.view(request);
        // 415, then the address limit, before a byte of the body is read: a body that never parses is counted too.
        api.admitJson(view);
        byte[] body = MvcBodies.readJsonBytes(request, api.maxBodyBytes());
        return PdfMvcSupport.entity(api.sign(body, view));
    }
}
