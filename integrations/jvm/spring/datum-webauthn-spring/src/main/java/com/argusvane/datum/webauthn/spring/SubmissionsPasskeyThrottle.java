package com.argusvane.datum.webauthn.spring;

import com.argusvane.datum.submissions.spi.SubmissionThrottle;
import com.argusvane.datum.submissions.spi.ThrottleDecision;
import com.argusvane.datum.submissions.spi.ThrottleKey;
import com.argusvane.datum.webauthn.web.PasskeyThrottle;
import java.util.Objects;

/**
 * Counts passkey challenges and registrations in datum-submissions' {@link SubmissionThrottle} under the kind
 * {@link ThrottleKey.Kind#REGISTER}, and every passkey request the routes count under its address limit, so one limit (and one replacement bean: a gateway's, a Redis-backed one)
 * covers the whole host. Loaded only when datum-submissions is on the class path. The development default of the
 * binding (framework-first): the library keeps the {@link PasskeyThrottle} contract, and the throttle
 * behind this adapter is the submissions binding's.
 */
public final class SubmissionsPasskeyThrottle implements PasskeyThrottle {

    private final SubmissionThrottle throttle;

    public SubmissionsPasskeyThrottle(SubmissionThrottle throttle) {
        this.throttle = Objects.requireNonNull(throttle, "throttle");
    }

    @Override
    public Decision check(String ip, String formKey, String principal) {
        ThrottleKey key = new ThrottleKey(ip, formKey, principal, ThrottleKey.Kind.REGISTER);
        ThrottleDecision decision = throttle.check(key);
        if (decision instanceof ThrottleDecision.Deny deny) {
            return new Decision.Deny(deny.retryAfter());
        }
        throttle.record(key);
        return Decision.ALLOW;
    }

    /** The submissions throttle's address limit: one count per address across the passkey and submission routes. */
    @Override
    public Decision checkAddress(String ip) {
        ThrottleDecision.Deny deny = SubmissionThrottle.admitAddress(throttle, ip);
        return deny == null ? Decision.ALLOW : new Decision.Deny(deny.retryAfter());
    }
}
