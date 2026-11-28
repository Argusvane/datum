package com.argusvane.datum.core.contracts;

import com.fasterxml.jackson.annotation.JsonAnyGetter;
import com.fasterxml.jackson.annotation.JsonAnySetter;
import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.LinkedHashMap;
import java.util.Map;
import tools.jackson.databind.JsonNode;

/**
 * One value path of a definition.
 *
 * <p>Members the Java side does not name are kept in {@code extra} and written back, so a newer
 * program's additions round-trip (the TypeScript type is open).
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record InspectedPath(
    String path,
    String componentId,
    String type,
    Boolean holdsData,
    InspectedPathSource source,
    InspectedPathCollection collection,
    @JsonAnySetter @JsonAnyGetter Map<String, JsonNode> extra
) {

    public InspectedPath {
        extra = extra == null ? new LinkedHashMap<>() : new LinkedHashMap<>(extra);
    }
}
