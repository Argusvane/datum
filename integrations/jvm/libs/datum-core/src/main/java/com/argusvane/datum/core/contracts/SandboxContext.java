package com.argusvane.datum.core.contracts;

import com.fasterxml.jackson.annotation.JsonAnyGetter;
import com.fasterxml.jackson.annotation.JsonAnySetter;
import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import tools.jackson.databind.JsonNode;

/**
 * The submission context that crosses the sandbox ABI (WasmSubmissionContext, ABI 2.14): values plus the schema, never the browser-only requiredComponents, invalidComponents or inputStates.
 *
 * <p>Members the Java side does not name are kept in {@code extra} and written back, so a newer
 * program's additions round-trip (the TypeScript type is open).
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record SandboxContext(
    String formId,
    JsonNode form,
    JsonNode values,
    String locale,
    JsonNode externalData,
    String unknownFields,
    String logLevel,
    JsonNode journey,
    String page,
    String today,
    String formulaErrors,
    String riskyPatterns,
    Boolean reportFold,
    JsonNode document,
    Map<String,List<OptionItem>> optionSnapshot,
    @JsonAnySetter @JsonAnyGetter Map<String, JsonNode> extra
) {

    public SandboxContext {
        extra = extra == null ? new LinkedHashMap<>() : new LinkedHashMap<>(extra);
        // Browser-only state never crosses the ABI (the TS context omits these on purpose).
        extra.keySet().removeAll(List.of("requiredComponents", "invalidComponents", "inputStates", "log"));
    }
}
