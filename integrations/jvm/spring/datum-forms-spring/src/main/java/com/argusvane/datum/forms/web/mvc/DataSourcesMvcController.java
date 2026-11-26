package com.argusvane.datum.forms.web.mvc;

import com.argusvane.datum.forms.web.FormsApi;
import com.argusvane.datum.springweb.mvc.DatumController;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.Parameter;
import io.swagger.v3.oas.annotations.enums.ParameterIn;
import io.swagger.v3.oas.annotations.media.Content;
import io.swagger.v3.oas.annotations.media.Schema;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** {@code GET {api}/data-sources/{id}?locale=} on Spring MVC; registered when {@code datum.web.api.endpoints.data-sources} is on. */
@RestController
@DatumController
@Tag(name = "datum-forms")
@RequestMapping("#{@datumFormsRoutes.api()}")
public class DataSourcesMvcController {

    private static final String ERRORS = "#/components/schemas/ErrorsBody";

    private final FormsApi api;

    public DataSourcesMvcController(FormsApi api) {
        this.api = api;
    }

    @GetMapping(value = "/data-sources/{id}")
    @Operation(operationId = "getDataSourceItems", summary = "A data source's options",
        parameters = {
            @Parameter(name = "id", in = ParameterIn.PATH, required = true, description = "The data source id."),
            @Parameter(name = "locale", in = ParameterIn.QUERY, description = "A locale code such as fr-CA."),
            @Parameter(name = "form", in = ParameterIn.QUERY, description = "The form being filled; the application's security may read it (the per-form recipe).")},
        responses = {
            @ApiResponse(responseCode = "200", description = "{items: [{value, label, description?}]}.",
                content = @Content(mediaType = "application/json", schema = @Schema(type = "object"))),
            @ApiResponse(responseCode = "403", description = "Refused by the application's security (access.denied when it installs DatumSecurityResponses).",
                content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
            @ApiResponse(responseCode = "404", description = "No provider, or an unknown source (data_source.notFound).",
                content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS)))})
    public ResponseEntity<byte[]> items(@PathVariable String id,
                                        @RequestParam(name = "locale", required = false) String locale,
                                        HttpServletRequest request) {
        return FormsMvcSupport.entity(api.dataSource(id, locale, request.getUserPrincipal()));
    }
}
