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
 * {@code POST {api}/submissions/test} on Spring MVC. Registered by the submissions auto-configuration only when
 * {@code datum.web.api.endpoints.test} is on, so an application that turns it off may map that path itself.
 * The body is read raw (415, the address limit, then the cap counted on the stream) and handed to the shared
 * {@link SubmissionsApi}; exceptions go through the Datum advice because of {@link DatumController}.
 */
@RestController
@DatumController
@Tag(name = "datum-submissions", description = "Submissions: delivery, journey checks, dry runs and inspection.")
@RequestMapping("#{@datumSubmissionsRoutes.api()}")
public class TestMvcController {

    private final SubmissionsApi api;

    public TestMvcController(SubmissionsApi api) {
        this.api = api;
    }

    @PostMapping("submissions/test")
    @Operation(operationId = "testSubmission", summary = "Dry run of a submission (for people who build)", description = "Runs every step but calls no handler, publishes no event and records no use; 200 carries the report whether the outcome is accepted or rejected. Off by default.",
        requestBody = @RequestBody(required = true, content = @Content(mediaType = "application/json", schema = @Schema(type = "object"))),
        responses = {
            @ApiResponse(responseCode = "200", description = "The report. Besides the verdict, the errors and the kept values it names four lists of component ids, each always present and empty when none apply: visibilitySkipped (fields whose own visibleWhen the server could not replay, treated as hidden for requiredness), clientDerived (answers worked out in the browser and kept as sent), clockDependent (components and pages whose rules read the clock) and serverRules (components whose server or server-secret rules the run applied).",
                content = @Content(mediaType = "application/json", schema = @Schema(type = "object"))),
            @ApiResponse(responseCode = "403", description = "Refused by the application's security (access.denied when it installs DatumSecurityResponses).",
                content = @Content(mediaType = "application/json", schema = @Schema(ref = "#/components/schemas/ErrorsBody"))),
            @ApiResponse(responseCode = "404", description = "No such form (form.notFound).",
                content = @Content(mediaType = "application/json", schema = @Schema(ref = "#/components/schemas/ErrorsBody")))})
    public ResponseEntity<byte[]> test(HttpServletRequest request) {
        SubmissionRequest view = SubmissionsMvcSupport.view(request);
        // 415, then the address limit, before a byte of the body is read: a body that never parses is counted too.
        api.admit(SubmissionMode.TEST, view);
        byte[] body = MvcBodies.readJsonBytes(request, api.maxBodyBytes());
        return SubmissionsMvcSupport.entity(api.test(body, view));
    }
}
