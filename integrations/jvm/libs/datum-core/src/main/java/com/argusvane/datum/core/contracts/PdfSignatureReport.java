package com.argusvane.datum.core.contracts;

import com.fasterxml.jackson.annotation.JsonAnyGetter;
import com.fasterxml.jackson.annotation.JsonAnySetter;
import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import tools.jackson.databind.JsonNode;

/**
 * One signature of a verified PDF (PdfSignatureReport); nullable members are JSON nodes so null survives.
 *
 * <p>Members the Java side does not name are kept in {@code extra} and written back, so a newer
 * program's additions round-trip (the TypeScript type is open).
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record PdfSignatureReport(
    String field,
    String subFilter,
    List<Long> byteRange,
    Boolean coversDocument,
    Boolean digestMatches,
    Boolean certificateMatches,
    JsonNode signer,
    JsonNode signerSource,
    List<String> certificates,
    String signatureAlgorithm,
    String toBeVerified,
    String signature,
    String signatureP1363,
    JsonNode signingTime,
    String signingTimeAttribute,
    String reason,
    String location,
    String name,
    String contactInfo,
    JsonNode certification,
    PdfTimestampReport timestamp,
    JsonNode commitment,
    String details,
    PdfSignatureDetails signedRevision,
    JsonNode changedAfter,
    PdfLaterRevisionsReport laterRevisions,
    JsonNode signedDocumentId,
    @JsonAnySetter @JsonAnyGetter Map<String, JsonNode> extra
) {

    public PdfSignatureReport {
        extra = extra == null ? new LinkedHashMap<>() : new LinkedHashMap<>(extra);
    }
}
