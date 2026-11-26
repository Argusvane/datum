package com.argusvane.datum.submissions.web.mvc;

import com.argusvane.datum.springweb.mvc.DatumController;
import com.argusvane.datum.springweb.mvc.MvcBodies;
import com.argusvane.datum.submissions.spi.SubmissionMode;
import com.argusvane.datum.submissions.spi.SubmissionRequest;
import com.argusvane.datum.submissions.web.SubmissionsApi;
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
 * {@code POST {api}/submissions} on Spring MVC. Registered by the submissions auto-configuration only when
 * {@code datum.web.api.endpoints.submissions} is on, so an application that turns it off may map that path itself.
 * The body is read raw (415, the address limit, then the cap counted on the stream) and handed to the shared
 * {@link SubmissionsApi}; exceptions go through the Datum advice because of {@link DatumController}.
 */
@RestController
@DatumController
@Tag(name = "datum-submissions", description = "Submissions: delivery, journey checks, dry runs and inspection.")
@RequestMapping("#{@datumSubmissionsRoutes.api()}")
public class SubmitMvcController {

    private final SubmissionsApi api;

    public SubmitMvcController(SubmissionsApi api) {
        this.api = api;
    }

    @PostMapping("submissions")
    @Operation(operationId = "submitSubmission", summary = "Deliver a submission", description = "{document, submissionKey}: the envelope is validated by the form's own rules in the sandbox, then handed to the application's SubmissionHandler; submissionKey is minted once per submit attempt and sent again on a retry. 409 form.outdated: the page was built from an older version; 409 submission.keyConflict: the key was accepted with another document. A run that failed (wasm.execution_error, outcome_too_large, definition.tooDeep) is 503, never 422: it is no judgement of the answers.",
        requestBody = @RequestBody(required = true, content = @Content(mediaType = "application/json", schema = @Schema(type = "object"))),
        responses = {
            @ApiResponse(responseCode = "200", description = "The receipt {id, reference, status, digest, receipt?, warnings?}.",
                content = @Content(mediaType = "application/json", schema = @Schema(type = "object"))),
            @ApiResponse(responseCode = "403", description = "Refused by the application's security (access.denied when it installs DatumSecurityResponses).",
                content = @Content(mediaType = "application/json", schema = @Schema(ref = "#/components/schemas/ErrorsBody"))),
            @ApiResponse(responseCode = "404", description = "No such form (form.notFound).",
                content = @Content(mediaType = "application/json", schema = @Schema(ref = "#/components/schemas/ErrorsBody"))),
            @ApiResponse(responseCode = "409", description = "The page was built from an older version of the form (form.outdated), or the submission key was accepted with another document (submission.keyConflict).",
                content = @Content(mediaType = "application/json", schema = @Schema(ref = "#/components/schemas/ErrorsBody")))})
    public ResponseEntity<byte[]> submit(HttpServletRequest request) {
        SubmissionRequest view = SubmissionsMvcSupport.view(request);
        // 415, then the address limit, before a byte of the body is read: a body that never parses is counted too.
        api.admit(SubmissionMode.SUBMIT, view);
        byte[] body = MvcBodies.readJsonBytes(request, api.maxBodyBytes());
        return SubmissionsMvcSupport.entity(api.submit(body, view));
    }
}
