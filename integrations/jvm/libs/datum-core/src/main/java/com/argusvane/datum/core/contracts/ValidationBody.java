package com.argusvane.datum.core.contracts;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.List;

/**
 * A check's 200 body (validationBody).
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record ValidationBody(
    Boolean accepted,
    List<ValidationFieldError> errors,
    JourneyOutline journey
) {
}
