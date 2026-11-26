package com.argusvane.datum.submissions.spi;

import java.time.Duration;
import java.util.Objects;

/** A throttle's answer: go on, or wait. */
public sealed interface ThrottleDecision permits ThrottleDecision.Allow, ThrottleDecision.Deny {

    /** The one "go on". */
    Allow ALLOW = new Allow();

    /** Go on. */
    record Allow() implements ThrottleDecision {
    }

    /**
     * Refused: 429 {@code throttled} with {@code Retry-After} in whole seconds (at least one).
     *
     * @param retryAfter how long until the key may ask again
     */
    record Deny(Duration retryAfter) implements ThrottleDecision {

        public Deny {
            Objects.requireNonNull(retryAfter, "retryAfter");
            if (retryAfter.isNegative()) {
                retryAfter = Duration.ZERO;
            }
        }
    }
}
