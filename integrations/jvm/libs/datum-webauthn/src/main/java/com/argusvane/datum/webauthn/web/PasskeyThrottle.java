package com.argusvane.datum.webauthn.web;

import java.time.Duration;
import java.util.Objects;

/**
 * Limits how often one caller may ask for a challenge or register a passkey (429 {@code flood}, as the submission
 * routes answer it, REC-14). The facade knows no throttle product: the
 * auto-configuration adapts datum-submissions' {@code SubmissionThrottle} (kind {@code REGISTER}) when that jar is
 * present, and an application may supply its own bean.
 *
 * <p>The answer is a typed {@link Decision}, not a nullable {@link Duration}: a gateway or
 * Redis-backed throttle cannot confuse "allowed" with "denied, retry now" ({@code Duration.ZERO}). The type is this
 * library's own because datum-submissions, which has the sibling {@code ThrottleDecision}, is optional for webauthn.
 */
@FunctionalInterface
public interface PasskeyThrottle {

    /** No limit. */
    PasskeyThrottle NONE = (ip, formKey, principal) -> Decision.ALLOW;

    /**
     * Counts one attempt unless the caller has used up the limit.
     *
     * @param ip the client address as the routes count it (an IPv6 client by its /64, {@code CountedAddress}), or null
     * @param formKey the form, or null for a passkey made ahead of time
     * @param principal the principal's name, or null when anonymous
     * @return {@link Decision#ALLOW} when the attempt is allowed (and was counted), else a {@link Decision.Deny} saying
     *     how long until the caller may ask again
     */
    Decision check(String ip, String formKey, String principal);

    /**
     * The address limit: counts one request from the address unless it used up its limit, in a count apart from
     * {@link #check}'s. The routes that count a passkey request (the challenge, the registration, a passkey's test
     * challenge) ask it after the Content-Type check and before they read the body, so a body that never parses is
     * counted too. The default allows every address: a throttle that keeps no address limit.
     *
     * @param ip the client address as the routes count it (an IPv6 client by its /64, {@code CountedAddress}), never null:
     *     a request with no client address is not counted
     * @return {@link Decision#ALLOW} when the request is allowed (and was counted), else a {@link Decision.Deny}
     */
    default Decision checkAddress(String ip) {
        return Decision.ALLOW;
    }

    /** A throttle's answer: go on, or wait. */
    sealed interface Decision permits Decision.Allow, Decision.Deny {

        /** The one "go on". */
        Allow ALLOW = new Allow();

        /** Go on. */
        record Allow() implements Decision {
        }

        /**
         * Refused: 429 {@code flood} with {@code Retry-After} in whole seconds (at least one).
         *
         * @param retryAfter how long until the caller may ask again
         */
        record Deny(Duration retryAfter) implements Decision {

            public Deny {
                Objects.requireNonNull(retryAfter, "retryAfter");
                if (retryAfter.isNegative()) {
                    retryAfter = Duration.ZERO;
                }
            }
        }
    }
}
