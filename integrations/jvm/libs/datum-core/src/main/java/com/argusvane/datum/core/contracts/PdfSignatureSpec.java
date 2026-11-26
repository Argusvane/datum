package com.argusvane.datum.core.contracts;

import com.fasterxml.jackson.annotation.JsonAnyGetter;
import com.fasterxml.jackson.annotation.JsonAnySetter;
import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import tools.jackson.databind.JsonNode;

/**
 * A signature request (PdfSignatureSpec): the settings plus the signer's certificates. certify and appearance are false or a value, so JSON nodes.
 *
 * <p>Members the Java side does not name are kept in {@code extra} and written back, so a newer
 * program's additions round-trip (the TypeScript type is open).
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record PdfSignatureSpec(
    String subFilter,
    String digestAlgorithm,
    JsonNode certify,
    String field,
    String name,
    String reason,
    String location,
    String contactInfo,
    JsonNode appearance,
    Boolean timestamp,
    Boolean required,
    Integer placeholderBytes,
    PdfSignatureCommitment commitment,
    List<String> certificates,
    @JsonAnySetter @JsonAnyGetter Map<String, JsonNode> extra
) {

    public PdfSignatureSpec {
        extra = extra == null ? new LinkedHashMap<>() : new LinkedHashMap<>(extra);
    }
}
