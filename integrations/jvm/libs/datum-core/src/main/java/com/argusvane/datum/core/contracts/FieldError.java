package com.argusvane.datum.core.contracts;

import com.fasterxml.jackson.annotation.JsonInclude;
import org.jspecify.annotations.Nullable;

/**
 * A 422 body entry from a rejected record: codes and fields, never text (errorsBody). field is left out when no component.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record FieldError(
    @Nullable String field,
    String code
) {
}
