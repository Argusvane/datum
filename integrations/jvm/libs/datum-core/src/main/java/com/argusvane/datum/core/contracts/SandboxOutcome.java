package com.argusvane.datum.core.contracts;

import com.fasterxml.jackson.annotation.JsonAnyGetter;
import com.fasterxml.jackson.annotation.JsonAnySetter;
import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import tools.jackson.databind.JsonNode;

/**
 * What a run hands back (WasmSubmissionOutcome): the error contract, the sanitized values only when nothing blocked, the run log, and the optional results.
 *
 * <p>Members the Java side does not name are kept in {@code extra} and written back, so a newer
 * program's additions round-trip (the TypeScript type is open).
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record SandboxOutcome(
    List<ValidationError> errors,
    JsonNode values,
    List<LogEntry> logs,
    List<String> clientDerived,
    List<String> pageComponentIds,
    List<String> clockDependent,
    List<String> serverRules,
    List<String> visibilitySkipped,
    List<String> withheld,
    Map<String,EffectiveState> effectiveState,
    JsonNode submittable,
    JourneyTrace trace,
    List<IndexRow> index,
    String canonical,
    String digest,
    @JsonAnySetter @JsonAnyGetter Map<String, JsonNode> extra
) {

    public SandboxOutcome {
        extra = extra == null ? new LinkedHashMap<>() : new LinkedHashMap<>(extra);
    }
}
