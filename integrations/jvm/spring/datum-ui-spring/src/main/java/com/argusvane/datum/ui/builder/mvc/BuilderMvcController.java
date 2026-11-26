package com.argusvane.datum.ui.builder.mvc;

import com.argusvane.datum.forms.web.FormsApi;
import com.argusvane.datum.forms.web.FormsReply;
import com.argusvane.datum.springweb.mvc.DatumController;
import com.argusvane.datum.springweb.mvc.MvcBodies;
import com.argusvane.datum.ui.builder.Admission;
import com.argusvane.datum.ui.builder.BuilderApi;
import com.argusvane.datum.ui.builder.LocaleChanges;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.Parameter;
import io.swagger.v3.oas.annotations.enums.ParameterIn;
import io.swagger.v3.oas.annotations.headers.Header;
import io.swagger.v3.oas.annotations.media.Content;
import io.swagger.v3.oas.annotations.media.Schema;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.servlet.http.HttpServletRequest;
import java.util.Collections;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * The builder's write endpoints on Spring MVC. It only moves bytes: {@link BuilderApi} admits the request (404),
 * the body is read with the definition cap on the raw stream ({@link MvcBodies}: 415, 413), and {@link BuilderApi}
 * decides the rest. Who may write is the application's security in front of these routes (framework-first: {@code DatumRequestMatchers.builderWrites()}). Registered only with
 * {@code datum.builder.enabled=true}; exceptions go through the Datum advice because of {@link DatumController}. No
 * {@code consumes}: a wrong Content-Type must not be answered before the existence check.
 */
@RestController
@DatumController
@Tag(name = "datum-ui", description = "The builder's writes: create and save form definitions and their translations.")
@RequestMapping("#{@datumBuilderRoutes.api()}")
public class BuilderMvcController {

    private static final String ERRORS = "#/components/schemas/ErrorsBody";

    private final BuilderApi api;

    public BuilderMvcController(BuilderApi api) {
        this.api = api;
    }

    @PostMapping("/forms")
    @Operation(operationId = "createForm", summary = "Create a form from a definition",
        description = "The form key is the definition's id. The definition is checked by the sandbox kernel before it is stored.",
        requestBody = @io.swagger.v3.oas.annotations.parameters.RequestBody(required = true, description = "The form definition.",
            content = @Content(mediaType = "application/json", schema = @Schema(type = "object"))),
        parameters = @Parameter(name = LocaleChanges.HEADER, in = ParameterIn.HEADER,
            description = "The builder's language changes, JSON {removed: [codes], renamed: [{from, to}]}."),
        responses = {
            @ApiResponse(responseCode = "201", description = "Created: {key, version, sha256, savedAt, catalog, warnings, kernelWarnings}.",
                headers = @Header(name = "ETag", ref = "#/components/headers/ETag"),
                content = @Content(mediaType = "application/json", schema = @Schema(type = "object"))),
            @ApiResponse(responseCode = "403", description = "Refused by the application's security: building is for some people only (access.denied when it installs DatumSecurityResponses).",
                content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
            @ApiResponse(responseCode = "409", description = "A form has this id already (form.exists).",
                content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
            @ApiResponse(responseCode = "422", description = "Refused by the shape check or the kernel: errors[].code and kernel[].code name each finding (for example pattern.risky), with no top-level code; a too-deep or too-costly definition carries the top-level code definition.tooDeep or definition.tooCostly.",
                content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
            @ApiResponse(responseCode = "501", description = "The form repository is read-only (forms.readOnly).",
                content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS)))})
    public ResponseEntity<byte[]> create(HttpServletRequest request) {
        Admission admission = api.admitCreate();
        byte[] body = MvcBodies.readJsonBytes(request, api.maxDefinitionBytes());
        return entity(api.create(admission, body, header(request, LocaleChanges.HEADER), request.getUserPrincipal()));
    }

    @PutMapping("/forms/{key}")
    @Operation(operationId = "saveForm", summary = "Save a form's definition",
        description = "Order of refusals: the application's security (401/403), 404, 415, 413, 409 (If-Match is not the current hash), 400 (not JSON), 422 (shape, id, kernel verdict), 503 (the sandbox could not check it). Nothing is stored on any refusal.",
        requestBody = @io.swagger.v3.oas.annotations.parameters.RequestBody(required = true, description = "The form definition; its id must be the key.",
            content = @Content(mediaType = "application/json", schema = @Schema(type = "object"))),
        parameters = {
            @Parameter(name = "key", in = ParameterIn.PATH, required = true, description = "The form key."),
            @Parameter(name = "If-Match", in = ParameterIn.HEADER, description = "The ETag of the definition this save builds on (GET .../definition?public=false)."),
            @Parameter(name = LocaleChanges.HEADER, in = ParameterIn.HEADER,
                description = "The builder's language changes, JSON {removed: [codes], renamed: [{from, to}]}.")},
        responses = {
            @ApiResponse(responseCode = "200", description = "Saved: {key, version, sha256, savedAt, catalog, warnings, kernelWarnings}.",
                headers = {
                    @Header(name = "ETag", ref = "#/components/headers/ETag"),
                    @Header(name = BuilderApi.REMOVED_LOCALES_HEADER, ref = "#/components/headers/XDatumRemovedLocales")},
                content = @Content(mediaType = "application/json", schema = @Schema(type = "object"))),
            @ApiResponse(responseCode = "403", description = "Refused by the application's security: building is for some people only (access.denied when it installs DatumSecurityResponses).",
                content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
            @ApiResponse(responseCode = "404", description = "No such form (form.notFound).",
                content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
            @ApiResponse(responseCode = "409", description = "The form changed since it was loaded (form.outdated); currentSha256 and the ETag name the current one.",
                headers = @Header(name = "ETag", ref = "#/components/headers/ETag"),
                content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
            @ApiResponse(responseCode = "422", description = "Refused by the shape check or the kernel: errors[].code and kernel[].code name each finding (for example pattern.risky), with no top-level code; a too-deep or too-costly definition carries the top-level code definition.tooDeep or definition.tooCostly.",
                content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
            @ApiResponse(responseCode = "501", description = "The form repository is read-only (forms.readOnly).",
                content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS)))})
    public ResponseEntity<byte[]> update(@PathVariable String key, HttpServletRequest request) {
        Admission admission = api.admitUpdate(key);
        byte[] body = MvcBodies.readJsonBytes(request, api.maxDefinitionBytes());
        return entity(api.update(admission, body, header(request, "If-Match"), header(request, LocaleChanges.HEADER), request.getUserPrincipal()));
    }

    @PutMapping("/forms/{key}/translations")
    @Operation(operationId = "saveFormTranslations", summary = "Save a form's host translation catalog",
        requestBody = @io.swagger.v3.oas.annotations.parameters.RequestBody(required = true, description = "{catalog: {locale: {kind: {owner: tree}}}}, or the catalog itself.",
            content = @Content(mediaType = "application/json", schema = @Schema(type = "object"))),
        parameters = {
            @Parameter(name = "key", in = ParameterIn.PATH, required = true, description = "The form key."),
            @Parameter(name = "If-Match", in = ParameterIn.HEADER, description = "The ETag of the catalog this save builds on (GET .../translations).")},
        responses = {
            @ApiResponse(responseCode = "200", description = "Saved: {catalog, entries, savedAt}.",
                headers = @Header(name = "ETag", ref = "#/components/headers/ETag"),
                content = @Content(mediaType = "application/json", schema = @Schema(type = "object"))),
            @ApiResponse(responseCode = "403", description = "Refused by the application's security: building is for some people only (access.denied when it installs DatumSecurityResponses).",
                content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
            @ApiResponse(responseCode = "404", description = "No such form (form.notFound).",
                content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
            @ApiResponse(responseCode = "409", description = "The catalog changed since it was loaded (form.outdated).",
                headers = @Header(name = "ETag", ref = "#/components/headers/ETag"),
                content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
            @ApiResponse(responseCode = "422", description = "Not a catalog (catalog.invalid).",
                content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS)))})
    public ResponseEntity<byte[]> translations(@PathVariable String key, HttpServletRequest request) {
        Admission admission = api.admitTranslations(key);
        byte[] body = MvcBodies.readJsonBytes(request, api.maxDefinitionBytes());
        return entity(api.translations(admission, body, header(request, "If-Match"), request.getUserPrincipal()));
    }

    /**
     * A header from all its lines ({@link BuilderApi#header}): read here rather than through {@code @RequestHeader}
     * so the joining is the one the WebFlux handlers use, not the conversion service's. The operations declare
     * the headers for the OpenAPI document themselves.
     */
    private static String header(HttpServletRequest request, String name) {
        return BuilderApi.header(Collections.list(request.getHeaders(name)));
    }

    private static ResponseEntity<byte[]> entity(FormsReply reply) {
        ResponseEntity.BodyBuilder builder = ResponseEntity.status(reply.status());
        reply.headers().forEach(builder::header);
        return builder.contentType(MediaType.parseMediaType(FormsApi.contentType())).body(reply.body());
    }
}
