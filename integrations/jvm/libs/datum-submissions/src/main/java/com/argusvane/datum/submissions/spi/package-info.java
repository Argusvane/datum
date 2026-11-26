/**
 * The extension points of the submissions module: the hooks an application implements (pre-check, validator, handler,
 * signature check, throttle, idempotency store, sandbox contributions) and the plain data they are handed.
 *
 * <p>Nullability: the package is {@code @NullMarked}, so a type with no
 * annotation is non-null and {@code @Nullable} marks the places a null is meant: an anonymous caller's principal, a client
 * address a non-HTTP channel does not have, an optional message or reference. A Kotlin or IDE user who implements these
 * interfaces gets real nullable and non-null types instead of platform types.
 */
@NullMarked
package com.argusvane.datum.submissions.spi;

import org.jspecify.annotations.NullMarked;
