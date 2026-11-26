package com.argusvane.datum.core.contracts;

import com.fasterxml.jackson.annotation.JsonAnyGetter;
import com.fasterxml.jackson.annotation.JsonAnySetter;
import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import tools.jackson.databind.JsonNode;

/**
 * fill op: fill a template's fields and areas.
 *
 * <p>Members the Java side does not name are kept in {@code extra} and written back, so a newer
 * program's additions round-trip (the TypeScript type is open).
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record PdfFillRequest(
    String abi,
    PdfTemplateBytes template,
    JsonNode values,
    JsonNode areas,
    List<PdfFont> fonts,
    PdfEnv env,
    JsonNode options,
    JsonNode conformance,
    JsonNode attachments,
    PdfSignatureSpec signature,
    JsonNode typography,
    JsonNode colors,
    @JsonAnySetter @JsonAnyGetter Map<String, JsonNode> extra
) implements PdfRequest {

    public PdfFillRequest {
        extra = extra == null ? new LinkedHashMap<>() : new LinkedHashMap<>(extra);
    }
}
