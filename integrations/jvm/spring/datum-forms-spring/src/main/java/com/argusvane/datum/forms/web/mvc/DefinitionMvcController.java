package com.argusvane.datum.forms.web.mvc;

import com.argusvane.datum.forms.web.FormsApi;
import com.argusvane.datum.springweb.mvc.DatumController;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.Parameter;
import io.swagger.v3.oas.annotations.enums.ParameterIn;
import io.swagger.v3.oas.annotations.headers.Header;
import io.swagger.v3.oas.annotations.media.Content;
import io.swagger.v3.oas.annotations.media.Schema;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import io.swagger.v3.oas.annotations.tags.Tag;
import java.security.Principal;
import java.util.Locale;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * {@code GET {api}/forms/{key}/definition} and {@code .../translations} on Spring MVC. Registered by
 * {@code DatumFormsWebAutoConfiguration} only when {@code datum.web.api.endpoints.definition} is on, so an
 * application that turns it off may map those paths itself. Exceptions go through the Datum advice because of
 * {@link DatumController}.
 */
@RestController
@DatumController
@Tag(name = "datum-forms", description = "Form definitions, translations and data sources.")
@RequestMapping("#{@datumFormsRoutes.api()}")
public class DefinitionMvcController {

    private static final String ERRORS = "#/components/schemas/ErrorsBody";

    private final FormsApi api;

    public DefinitionMvcController(FormsApi api) {
        this.api = api;
    }

    @GetMapping(value = "/forms/{key}/definition")
    @Operation(operationId = "getFormDefinition", summary = "A form's definition",
        description = "The public copy by default (server-secret rules removed); public=false is served only while the builder is on (datum.builder.enabled), else 404, and is for people who build (DatumRequestMatchers.builderReads()); sha256 serves that version.",
        parameters = {
            @Parameter(name = "key", in = ParameterIn.PATH, required = true, description = "The form key."),
            @Parameter(name = "public", in = ParameterIn.QUERY, description = "true (default) for the public copy, false for the full definition.",
                schema = @Schema(type = "boolean", defaultValue = "true")),
            @Parameter(name = "sha256", in = ParameterIn.QUERY, description = "A version of the form by hash.", schema = @Schema(type = "string")),
            @Parameter(name = "If-None-Match", in = ParameterIn.HEADER, description = "The ETag of the copy the client holds.")},
        responses = {
            @ApiResponse(responseCode = "200", description = "The definition.",
                headers = @Header(name = "ETag", ref = "#/components/headers/ETag"),
                content = @Content(mediaType = "application/json", schema = @Schema(type = "object"))),
            @ApiResponse(responseCode = "304", description = "The client's copy is current."),
            @ApiResponse(responseCode = "400", description = "public is not true or false (bad_request).",
                content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
            @ApiResponse(responseCode = "403", description = "Refused by the application's security (access.denied when it installs DatumSecurityResponses).",
                content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
            @ApiResponse(responseCode = "404", description = "No such form or version (form.notFound); public=false with the builder off (no body).",
                content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS)))})
    public ResponseEntity<byte[]> definition(@PathVariable String key,
                                             @RequestParam(name = "public", required = false) String publicParam,
                                             @RequestParam(name = "sha256", required = false) String sha256,
                                             @RequestHeader(name = "If-None-Match", required = false) String ifNoneMatch,
                                             Principal principal, Locale locale) {
        // The principal and the locale (Spring's LocaleResolver) reach the application's DefinitionCustomizers.
        return FormsMvcSupport.entity(api.definition(key, publicParam, sha256, ifNoneMatch, principal, locale));
    }

    @GetMapping(value = "/forms/{key}/translations")
    @Operation(operationId = "getFormTranslations", summary = "A form's host translation catalog",
        parameters = {
            @Parameter(name = "key", in = ParameterIn.PATH, required = true, description = "The form key."),
            @Parameter(name = "If-None-Match", in = ParameterIn.HEADER, description = "The ETag of the catalog the client holds.")},
        responses = {
            @ApiResponse(responseCode = "200", description = "{catalog: {locale: {kind: {owner: tree}}}}.",
                headers = @Header(name = "ETag", ref = "#/components/headers/ETag"),
                content = @Content(mediaType = "application/json", schema = @Schema(type = "object"))),
            @ApiResponse(responseCode = "304", description = "The client's catalog is current."),
            @ApiResponse(responseCode = "403", description = "Refused by the application's security (access.denied when it installs DatumSecurityResponses).",
                content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
            @ApiResponse(responseCode = "404", description = "No such form (form.notFound).",
                content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS)))})
    public ResponseEntity<byte[]> translations(@PathVariable String key,
                                               @RequestHeader(name = "If-None-Match", required = false) String ifNoneMatch) {
        return FormsMvcSupport.entity(api.translations(key, ifNoneMatch));
    }
}
