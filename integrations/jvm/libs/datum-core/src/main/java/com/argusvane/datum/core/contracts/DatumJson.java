package com.argusvane.datum.core.contracts;

import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.MapperFeature;
import tools.jackson.databind.json.JsonMapper;

/**
 * The mapper the contract records are meant to be read with.
 *
 * <p>Jackson's defaults coerce a number into a String member and a float into a Long, so a document read
 * and written back would no longer be the bytes a signature or digest covers. This factory turns both off
 * (a wrong-typed scalar is refused instead of rewritten); members that may be an explicit JSON null are
 * {@code JsonNode} on the records for the same reason.
 */
public final class DatumJson {

    private DatumJson() {
    }

    /** A new strict-scalar mapper; share the instance, it is thread-safe once built. */
    public static JsonMapper mapper() {
        return JsonMapper.builder()
            .disable(MapperFeature.ALLOW_COERCION_OF_SCALARS)
            .disable(DeserializationFeature.ACCEPT_FLOAT_AS_INT)
            .build();
    }
}
