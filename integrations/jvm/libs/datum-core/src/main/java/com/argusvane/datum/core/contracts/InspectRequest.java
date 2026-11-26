package com.argusvane.datum.core.contracts;

import com.fasterxml.jackson.annotation.JsonAnyGetter;
import com.fasterxml.jackson.annotation.JsonAnySetter;
import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import tools.jackson.databind.JsonNode;

/**
 * The inspect entry point's request (DefinitionInspectRequest): abi, op public|check|inspect, the definition, and for check the host's policy and type list.
 *
 * <p>Members the Java side does not name are kept in {@code extra} and written back, so a newer
 * program's additions round-trip (the TypeScript type is open).
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record InspectRequest(
    String abi,
    String op,
    JsonNode definition,
    String formulaErrors,
    String riskyPatterns,
    List<String> types,
    @JsonAnySetter @JsonAnyGetter Map<String, JsonNode> extra
) {

    public InspectRequest {
        extra = extra == null ? new LinkedHashMap<>() : new LinkedHashMap<>(extra);
    }
}
