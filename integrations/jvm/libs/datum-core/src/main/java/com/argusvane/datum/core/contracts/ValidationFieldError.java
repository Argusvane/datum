package com.argusvane.datum.core.contracts;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * An entry of a check's 200 body (validationBody): field null when none; severity only for a warning or a note.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record ValidationFieldError(
    @JsonInclude(JsonInclude.Include.ALWAYS) String field,
    String code,
    String severity
) {
}
