package com.argusvane.datum.core.contracts;

import com.fasterxml.jackson.annotation.JsonAnyGetter;
import com.fasterxml.jackson.annotation.JsonAnySetter;
import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import tools.jackson.databind.JsonNode;

/**
 * sign op: first call of the two-call signing hand-off.
 *
 * <p>Members the Java side does not name are kept in {@code extra} and written back, so a newer
 * program's additions round-trip (the TypeScript type is open).
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record PdfSignRequest(
    String abi,
    PdfBytes pdf,
    PdfSignatureSpec signature,
    List<PdfFont> fonts,
    PdfEnv env,
    @JsonAnySetter @JsonAnyGetter Map<String, JsonNode> extra
) implements PdfRequest {

    public PdfSignRequest {
        extra = extra == null ? new LinkedHashMap<>() : new LinkedHashMap<>(extra);
    }
}
