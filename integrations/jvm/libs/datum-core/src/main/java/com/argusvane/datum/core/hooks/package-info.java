/**
 * The pieces every capability's lifecycle hooks share: the typed refusal a hook
 * answers instead of letting a request go on ({@link com.argusvane.datum.core.hooks.HookRefusedException}), and
 * what a validator finds ({@link com.argusvane.datum.core.hooks.HookProblem},
 * {@link com.argusvane.datum.core.hooks.HookFindings}).
 *
 * <p>The model, the same for every capability: a {@code *Customizer} runs before the engine or the store is asked and
 * may adjust a typed draft in place or refuse; a {@code *Validator} (or {@code *Check}) runs after the engine answered and
 * before the effect, sees the verdict, and may add errors (refusing) or warnings (riding along); one {@code *Handler} is
 * the effect; {@code *Event} records follow it. A hook is an ordered list (the framework's order); a hook that throws
 * anything but its capability's typed refusal fails the request. The interfaces and their call sites live in the
 * libraries, because the pipeline they interrupt lives there; discovery and ordering are the binding's.
 *
 * <p>Nullability: the package is {@code @NullMarked}, so a type with no annotation is
 * non-null and {@code @Nullable} marks the places a null is meant (an optional member, an unset option, a "none" answer).
 */
@NullMarked
package com.argusvane.datum.core.hooks;

import org.jspecify.annotations.NullMarked;
