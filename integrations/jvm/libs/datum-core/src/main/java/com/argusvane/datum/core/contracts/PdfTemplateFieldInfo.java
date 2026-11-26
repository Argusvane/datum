package com.argusvane.datum.core.contracts;

import com.fasterxml.jackson.annotation.JsonAnyGetter;
import com.fasterxml.jackson.annotation.JsonAnySetter;
import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import tools.jackson.databind.JsonNode;

/**
 * One field of a template (PdfTemplateFieldInfo).
 *
 * <p>Members the Java side does not name are kept in {@code extra} and written back, so a newer
 * program's additions round-trip (the TypeScript type is open).
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record PdfTemplateFieldInfo(
    String name,
    String kind,
    Integer page,
    JsonNode rect,
    List<String> options,
    List<String> exportValues,
    Integer maxLength,
    Boolean multiline,
    Boolean readOnly,
    Boolean required,
    JsonNode value,
    Boolean signed,
    String tooltip,
    @JsonAnySetter @JsonAnyGetter Map<String, JsonNode> extra
) {

    public PdfTemplateFieldInfo {
        extra = extra == null ? new LinkedHashMap<>() : new LinkedHashMap<>(extra);
    }
}
