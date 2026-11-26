package com.argusvane.datum.pdf.web.mvc;

import com.argusvane.datum.pdf.api.PdfApi;
import com.argusvane.datum.springweb.mvc.DatumController;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.media.Content;
import io.swagger.v3.oas.annotations.media.Schema;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * {@code GET {api}/server/certificate} on Spring MVC: the server's PDF signing chain as PEM, leaf first, so a verifier
 * can trust what the server sealed. Public by design (a certificate is not a secret); registered only when
 * {@code datum.web.api.endpoints.certificate} is on.
 */
@RestController
@DatumController
@Tag(name = "datum-pdf", description = "PDF: render, fill, sign and verify.")
@RequestMapping("#{@datumPdfRoutes.api()}")
public class CertificateMvcController {

    private final PdfApi api;

    public CertificateMvcController(PdfApi api) {
        this.api = api;
    }

    @GetMapping("server/certificate")
    @Operation(operationId = "serverCertificate", summary = "The server's PDF signing certificate chain",
        description = "PEM, leaf first. 404 certificate.notFound when the server has no signing key.",
        responses = {
            @ApiResponse(responseCode = "200", description = "The chain (application/x-pem-file).",
                content = @Content(mediaType = "application/x-pem-file", schema = @Schema(type = "string"))),
            @ApiResponse(responseCode = "404", description = "The server has no signing key (certificate.notFound).",
                content = @Content(mediaType = "application/json", schema = @Schema(ref = "#/components/schemas/ErrorsBody")))})
    public ResponseEntity<byte[]> certificate(HttpServletRequest request) {
        return PdfMvcSupport.entity(api.certificate(PdfMvcSupport.view(request)));
    }
}
