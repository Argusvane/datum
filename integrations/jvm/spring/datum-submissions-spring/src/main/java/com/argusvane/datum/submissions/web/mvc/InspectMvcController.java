package com.argusvane.datum.submissions.web.mvc;

import com.argusvane.datum.springweb.mvc.DatumController;
import com.argusvane.datum.springweb.mvc.MvcBodies;
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
 * {@code POST {api}/inspect} on Spring MVC. Registered by the submissions auto-configuration only when
 * {@code datum.web.api.endpoints.inspect} is on, so an application that turns it off may map that path itself.
 * The body is read raw (415, then the cap counted on the stream) and handed to the shared
 * {@link SubmissionsApi}; exceptions go through the Datum advice because of {@link DatumController}.
 */
@RestController
@DatumController
@Tag(name = "datum-submissions", description = "Submissions: delivery, journey checks, dry runs and inspection.")
@RequestMapping("#{@datumSubmissionsRoutes.api()}")
public class InspectMvcController {

    private final SubmissionsApi api;

    public InspectMvcController(SubmissionsApi api) {
        this.api = api;
    }

    @PostMapping("inspect")
    @Operation(operationId = "inspectDefinition", summary = "The kernel's inspection of a definition (for operators)", description = "{form: key} inspects the current full definition, {definition: object} the one given; op is inspect (default) or public. Needs permission to build. Off by default.",
        requestBody = @RequestBody(required = true, content = @Content(mediaType = "application/json", schema = @Schema(type = "object"))),
        responses = {
            @ApiResponse(responseCode = "200", description = "The kernel's answer {ok, op, ...}.",
                content = @Content(mediaType = "application/json", schema = @Schema(type = "object"))),
            @ApiResponse(responseCode = "403", description = "Refused by the application's security (access.denied when it installs DatumSecurityResponses).",
                content = @Content(mediaType = "application/json", schema = @Schema(ref = "#/components/schemas/ErrorsBody"))),
            @ApiResponse(responseCode = "404", description = "No such form (form.notFound).",
                content = @Content(mediaType = "application/json", schema = @Schema(ref = "#/components/schemas/ErrorsBody")))})
    public ResponseEntity<byte[]> inspect(HttpServletRequest request) {
        byte[] body = MvcBodies.readJsonBytes(request, api.maxBodyBytes());
        return SubmissionsMvcSupport.entity(api.inspect(body, SubmissionsMvcSupport.view(request)));
    }
}
