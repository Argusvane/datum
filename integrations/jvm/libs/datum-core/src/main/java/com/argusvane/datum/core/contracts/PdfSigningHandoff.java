package com.argusvane.datum.core.contracts;

import com.fasterxml.jackson.annotation.JsonAnyGetter;
import com.fasterxml.jackson.annotation.JsonAnySetter;
import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import tools.jackson.databind.JsonNode;

/**
 * What an external signer needs: the byte range, digests, the data to be signed and the algorithm (PdfSigningHandoff).
 *
 * <p>Members the Java side does not name are kept in {@code extra} and written back, so a newer
 * program's additions round-trip (the TypeScript type is open).
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record PdfSigningHandoff(
    String field,
    List<Long> byteRange,
    String digest,
    String toBeSigned,
    String toBeSignedDigest,
    String signatureAlgorithm,
    String subFilter,
    @JsonAnySetter @JsonAnyGetter Map<String, JsonNode> extra
) {

    public PdfSigningHandoff {
        extra = extra == null ? new LinkedHashMap<>() : new LinkedHashMap<>(extra);
    }
}
