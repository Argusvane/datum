package com.argusvane.datum.core.contracts;

import com.fasterxml.jackson.annotation.JsonAnyGetter;
import com.fasterxml.jackson.annotation.JsonAnySetter;
import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import tools.jackson.databind.JsonNode;

/**
 * Absolute sandbox policy that crosses the ABI beside the context (WasmSandboxPolicy): no ambient authority.
 *
 * <p>Members the Java side does not name are kept in {@code extra} and written back, so a newer
 * program's additions round-trip (the TypeScript type is open).
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record SandboxPolicy(
    Boolean allowNetwork,
    Boolean allowFilesystem,
    Boolean allowProcess,
    Boolean allowEnvironment,
    List<String> allowedExternalDataKeys,
    @JsonAnySetter @JsonAnyGetter Map<String, JsonNode> extra
) {

    public SandboxPolicy {
        // WasmSandboxPolicy fixes these four to the literal false: no ambient authority.
        for (Boolean flag : new Boolean[] {allowNetwork, allowFilesystem, allowProcess, allowEnvironment}) {
            if (Boolean.TRUE.equals(flag)) {
                throw new IllegalArgumentException("The sandbox policy grants no ambient authority; allow* must be false.");
            }
        }
        extra = extra == null ? new LinkedHashMap<>() : new LinkedHashMap<>(extra);
    }
}
