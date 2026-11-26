package com.argusvane.datum.core.contracts;

import com.fasterxml.jackson.annotation.JsonAnyGetter;
import com.fasterxml.jackson.annotation.JsonAnySetter;
import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import tools.jackson.databind.JsonNode;

/**
 * What inspect learns of a template (PdfTemplateInfo).
 *
 * <p>Members the Java side does not name are kept in {@code extra} and written back, so a newer
 * program's additions round-trip (the TypeScript type is open).
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record PdfTemplateInfo(
    Integer pageCount,
    List<PdfPageSize> pages,
    List<PdfTemplateFieldInfo> fields,
    Boolean hasXfa,
    Boolean encrypted,
    JsonNode permissions,
    JsonNode pdfa,
    JsonNode attachments,
    List<PdfWarning> warnings,
    Integer signatures,
    @JsonAnySetter @JsonAnyGetter Map<String, JsonNode> extra
) {

    public PdfTemplateInfo {
        extra = extra == null ? new LinkedHashMap<>() : new LinkedHashMap<>(extra);
    }
}
