package com.argusvane.datum.web.json;

import tools.jackson.core.StreamReadConstraints;
import tools.jackson.core.json.JsonFactory;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.MapperFeature;
import tools.jackson.databind.json.JsonMapper;

/**
 * Datum's own {@link JsonMapper}, wrapped so it is not a {@code JsonMapper} bean.
 *
 * <p>A bean of the plain type would switch off Spring Boot's own mapper ({@code @ConditionalOnMissingBean})
 * and change every other JSON answer of the application. Datum's endpoints read untrusted documents, so the
 * mapper carries limits Jackson's defaults do not: nesting 256, a string no longer than the
 * body cap, numbers of at most 1000 characters. It also reads strictly: trailing tokens refuse, and a
 * wrong-typed scalar is refused instead of coerced (the same switches as {@code DatumJson.mapper()} of the
 * core, so the envelope's digest still covers the bytes that arrived).
 *
 * @param mapper the shared, thread-safe mapper
 */
public record DatumJsonMapper(JsonMapper mapper) {

    /** The nesting depth of a document a Datum endpoint reads. */
    public static final int MAX_NESTING = 256;

    /** The longest number a document may carry, in characters. */
    public static final int MAX_NUMBER_LENGTH = 1000;

    /** Builds the mapper for a body cap in bytes. */
    public static DatumJsonMapper create(long maxBodyBytes) {
        int stringLimit = (int) Math.min(Integer.MAX_VALUE, Math.max(1, maxBodyBytes));
        JsonFactory factory = JsonFactory.builder()
            .streamReadConstraints(StreamReadConstraints.builder()
                .maxNestingDepth(MAX_NESTING)
                .maxStringLength(stringLimit)
                .maxNumberLength(MAX_NUMBER_LENGTH)
                .maxDocumentLength(Math.max(1, maxBodyBytes))
                .build())
            .build();
        return new DatumJsonMapper(JsonMapper.builder(factory)
            .disable(MapperFeature.ALLOW_COERCION_OF_SCALARS)
            .disable(DeserializationFeature.ACCEPT_FLOAT_AS_INT)
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
            .build());
    }
}
