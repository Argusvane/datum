package com.argusvane.datum.web.error;

import java.util.Optional;

/**
 * An extension point for exceptions the mapper does not know (a capability's own, or an application's): beans
 * of this type are asked in bean order before the built-in mapping.
 */
@FunctionalInterface
public interface ErrorTranslator {

    /** The answer for {@code failure}, or empty to leave it to the next translator and the built-in mapping. */
    Optional<ErrorResponse> translate(Throwable failure);
}
