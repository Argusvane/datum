package com.argusvane.datum.core.contracts;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.List;

/**
 * A 422's body (errorsBody).
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record ErrorsBody(
    List<FieldError> errors
) {
}
