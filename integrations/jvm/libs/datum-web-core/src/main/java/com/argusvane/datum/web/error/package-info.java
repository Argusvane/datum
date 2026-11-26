/**
 * The error model every web binding shares: the exception-to-answer mapping ({@link com.argusvane.datum.web.error.ErrorMapper}),
 * the wire's {@code errors} entries, and the extension points an application or a capability uses to word its own
 * ({@link com.argusvane.datum.web.error.ErrorTranslator}, {@link com.argusvane.datum.web.error.ErrorDetails}).
 *
 * <p>Nullability: the package is {@code @NullMarked}, so a type with no
 * annotation is non-null and {@code @Nullable} marks the places a null is meant (an entry that names no field, an answer
 * with no challenge or cause).
 */
@NullMarked
package com.argusvane.datum.web.error;

import org.jspecify.annotations.NullMarked;
