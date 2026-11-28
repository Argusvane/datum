package com.argusvane.datum.core.contracts;

import com.fasterxml.jackson.annotation.JsonAnyGetter;
import com.fasterxml.jackson.annotation.JsonAnySetter;
import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import tools.jackson.databind.JsonNode;

/**
 * The path through a journey for one set of answers.
 *
 * <p>Members the Java side does not name are kept in {@code extra} and written back, so a newer
 * program's additions round-trip (the TypeScript type is open).
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record JourneyTrace(
    List<String> pages,
    String end,
    List<JourneyDecision> decisions,
    @JsonAnySetter @JsonAnyGetter Map<String, JsonNode> extra
) {

    public JourneyTrace {
        extra = extra == null ? new LinkedHashMap<>() : new LinkedHashMap<>(extra);
    }
}
