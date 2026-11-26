package com.argusvane.datum.core.contracts;

import com.fasterxml.jackson.annotation.JsonAnyGetter;
import com.fasterxml.jackson.annotation.JsonAnySetter;
import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import tools.jackson.databind.JsonNode;

/**
 * A verified RFC 3161 timestamp (PdfTimestampReport).
 *
 * <p>Members the Java side does not name are kept in {@code extra} and written back, so a newer
 * program's additions round-trip (the TypeScript type is open).
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record PdfTimestampReport(
    String time,
    String tsa,
    Boolean coversSignature,
    String token,
    String imprintAlgorithm,
    String imprint,
    String serial,
    String nonce,
    PdfTimestampAccuracy accuracy,
    String digestAlgorithm,
    String toBeVerified,
    String signatureAlgorithm,
    String signature,
    String signatureP1363,
    JsonNode signer,
    String signerSource,
    List<String> certificates,
    Boolean messageDigestMatches,
    Boolean contentTypeMatches,
    Boolean certificateMatches,
    @JsonAnySetter @JsonAnyGetter Map<String, JsonNode> extra
) {

    public PdfTimestampReport {
        extra = extra == null ? new LinkedHashMap<>() : new LinkedHashMap<>(extra);
    }
}
