package com.argusvane.datum.core.contracts;

import com.fasterxml.jackson.annotation.JsonAnyGetter;
import com.fasterxml.jackson.annotation.JsonAnySetter;
import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.LinkedHashMap;
import java.util.Map;
import tools.jackson.databind.JsonNode;

/**
 * The client versions an envelope records.
 *
 * <p>Members the Java side does not name are kept in {@code extra} and written back, so a newer
 * program's additions round-trip (the TypeScript type is open).
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record SubmissionClientVersions(
    String runtimeVersion,
    String rendererVersion,
    String schemaVersion,
    Map<String,String> components,
    Map<String,String> plugins,
    @JsonAnySetter @JsonAnyGetter Map<String, JsonNode> extra
) {

    public SubmissionClientVersions {
        extra = extra == null ? new LinkedHashMap<>() : new LinkedHashMap<>(extra);
    }
}
