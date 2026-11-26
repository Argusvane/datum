package com.argusvane.datum.core.contracts;

import com.fasterxml.jackson.annotation.JsonAnyGetter;
import com.fasterxml.jackson.annotation.JsonAnySetter;
import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import tools.jackson.databind.JsonNode;

/**
 * The wrapper placement: the envelope untouched as payload, the signatures beside it.
 *
 * <p>The payload stays a {@code JsonNode}: it is the bytes a signature covers, so it must come back exactly
 * as it arrived (no scalar coercion, no dropped nulls). Read it as a {@link SubmissionEnvelope} on demand.
 *
 * <p>Members the Java side does not name are kept in {@code extra} and written back, so a newer
 * program's additions round-trip (the TypeScript type is open).
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record SignedSubmissionDocument(
    SigningFormat format,
    JsonNode payload,
    List<SignatureResult> signatures,
    @JsonAnySetter @JsonAnyGetter Map<String, JsonNode> extra
) {

    public SignedSubmissionDocument {
        extra = extra == null ? new LinkedHashMap<>() : new LinkedHashMap<>(extra);
    }
}
