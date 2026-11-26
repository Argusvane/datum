package com.argusvane.datum.core.contracts;

import com.fasterxml.jackson.annotation.JsonAnyGetter;
import com.fasterxml.jackson.annotation.JsonAnySetter;
import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.LinkedHashMap;
import java.util.Map;
import tools.jackson.databind.JsonNode;

/**
 * A formula problem the compile reports (FormulaProblem).
 *
 * <p>Members the Java side does not name are kept in {@code extra} and written back, so a newer
 * program's additions round-trip (the TypeScript type is open).
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record FormulaProblem(
    String where,
    String code,
    String severity,
    String message,
    JsonNode params,
    Integer start,
    Integer end,
    String text,
    @JsonAnySetter @JsonAnyGetter Map<String, JsonNode> extra
) {

    public FormulaProblem {
        extra = extra == null ? new LinkedHashMap<>() : new LinkedHashMap<>(extra);
    }
}
