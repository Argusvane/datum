package com.argusvane.datum.core.contracts;

import com.fasterxml.jackson.annotation.JsonAnyGetter;
import com.fasterxml.jackson.annotation.JsonAnySetter;
import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.LinkedHashMap;
import java.util.Map;
import tools.jackson.databind.JsonNode;

/**
 * The structure caps in force, echoed so a host can pin its own copies.
 *
 * <p>Members the Java side does not name are kept in {@code extra} and written back, so a newer
 * program's additions round-trip (the TypeScript type is open).
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record DefinitionLimits(
    Integer depth,
    Integer components,
    Integer optionsPerComponent,
    Integer optionsTotal,
    Integer locales,
    Integer journeys,
    Integer pages,
    Integer routesPerPage,
    Integer pdfLayouts,
    Integer problems,
    @JsonAnySetter @JsonAnyGetter Map<String, JsonNode> extra
) {

    public DefinitionLimits {
        extra = extra == null ? new LinkedHashMap<>() : new LinkedHashMap<>(extra);
    }
}
