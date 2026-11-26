package com.argusvane.datum.web.error;

import java.util.List;
import java.util.Map;

/**
 * Implemented by a {@code DatumException} that carries more than one code and message: a 422 with a list of
 * field errors, a 429 with its {@code Retry-After}, a 409 that names the current definition.
 *
 * <p>The exceptions of the capability modules ({@code SubmissionRejectedException}, {@code ThrottledException},
 * {@code FormOutdatedException}) implement it so {@link ErrorMapper} stays free of every capability's types.
 */
public interface ErrorDetails {

    /** The entries of the {@code errors} list; empty means the exception's own code and message. */
    List<ErrorItem> errorItems();

    /** Headers to send with the answer ({@code Retry-After}, {@code ETag}). */
    default Map<String, String> responseHeaders() {
        return Map.of();
    }

    /** Extra top-level members of the JSON body (for example {@code currentSha256}); they never replace {@code errors}. */
    default Map<String, Object> extraBody() {
        return Map.of();
    }
}
