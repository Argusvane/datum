package com.argusvane.datum.core.contracts;

import com.fasterxml.jackson.annotation.JsonAnyGetter;
import com.fasterxml.jackson.annotation.JsonAnySetter;
import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.LinkedHashMap;
import java.util.Map;
import tools.jackson.databind.JsonNode;

/**
 * Everything a WebAuthn ceremony returned; userHandle may be null.
 *
 * <p>Members the Java side does not name are kept in {@code extra} and written back, so a newer
 * program's additions round-trip (the TypeScript type is open).
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record WebAuthnAssertion(
    String credentialId,
    String authenticatorData,
    String clientDataJSON,
    String signature,
    JsonNode userHandle,
    String publicKey,
    Integer algorithm,
    String rpId,
    String origin,
    String signedAt,
    @JsonAnySetter @JsonAnyGetter Map<String, JsonNode> extra
) {

    public WebAuthnAssertion {
        extra = extra == null ? new LinkedHashMap<>() : new LinkedHashMap<>(extra);
    }
}
