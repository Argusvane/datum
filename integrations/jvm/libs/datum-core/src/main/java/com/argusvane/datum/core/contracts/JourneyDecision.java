package com.argusvane.datum.core.contracts;

import com.fasterxml.jackson.annotation.JsonAnyGetter;
import com.fasterxml.jackson.annotation.JsonAnySetter;
import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.LinkedHashMap;
import java.util.Map;
import tools.jackson.databind.JsonNode;

/**
 * Why the journey path looks as it does, one decision per page left: kind route (routeIndex, to) or next (to).
 * Every page the walk reaches is on the path, so no decision passes one over.
 *
 * <p>Members the Java side does not name are kept in {@code extra} and written back, so a newer
 * program's additions round-trip (the TypeScript type is open).
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record JourneyDecision(
    String kind,
    String pageId,
    Integer routeIndex,
    String to,
    @JsonAnySetter @JsonAnyGetter Map<String, JsonNode> extra
) {

    public JourneyDecision {
        extra = extra == null ? new LinkedHashMap<>() : new LinkedHashMap<>(extra);
    }
}
