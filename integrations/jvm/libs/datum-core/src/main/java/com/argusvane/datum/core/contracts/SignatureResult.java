package com.argusvane.datum.core.contracts;

import com.fasterxml.jackson.annotation.JsonAnyGetter;
import com.fasterxml.jackson.annotation.JsonAnySetter;
import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.LinkedHashMap;
import java.util.Map;
import tools.jackson.databind.JsonNode;

/**
 * One signature (SignatureResult): the value, the algorithm, the format it was made under, and a WebAuthn assertion when there was one.
 *
 * <p>Members the Java side does not name are kept in {@code extra} and written back, so a newer
 * program's additions round-trip (the TypeScript type is open).
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record SignatureResult(
    String signature,
    String algorithm,
    Long signedAt,
    JsonNode participantId,
    SigningFormat format,
    WebAuthnAssertion webauthn,
    String statement,
    @JsonAnySetter @JsonAnyGetter Map<String, JsonNode> extra
) {

    public SignatureResult {
        extra = extra == null ? new LinkedHashMap<>() : new LinkedHashMap<>(extra);
    }
}
