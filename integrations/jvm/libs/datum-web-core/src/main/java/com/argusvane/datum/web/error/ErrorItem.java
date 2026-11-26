package com.argusvane.datum.web.error;

import com.fasterxml.jackson.annotation.JsonInclude;
import org.jspecify.annotations.Nullable;

/**
 * One entry of the error body {@code {errors:[{field?, code, message?}]}} (the endpoint catalog's error schema; the
 * browser glue reads {@code code}, {@code field} and {@code message}).
 *
 * @param field   the component id the error belongs to; left out of the JSON when it names none, so one rule holds for
 *                every error body and the validate verdict: {@code field} is present only when the error names one
 * @param code    the stable machine code
 * @param message host-worded text for a person, or {@code null}; never a guest's stderr or output
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record ErrorItem(@Nullable String field, String code, @Nullable String message) {

    public static ErrorItem of(String code) {
        return new ErrorItem(null, code, null);
    }

    public static ErrorItem of(String code, @Nullable String message) {
        return new ErrorItem(null, code, message);
    }
}
