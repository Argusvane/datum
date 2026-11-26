package com.argusvane.datum.submissions.spi;

import com.argusvane.datum.core.CountedAddress;
import org.jspecify.annotations.Nullable;

/**
 * Limits how often one key may ask: applied before anything costly, so a
 * refused request costs no sandbox run. Replace the bean with a gateway's or a Redis-backed one.
 *
 * <p>Two counts, in two key spaces that never share a window:
 * <ul>
 *   <li>The address limit ({@link #checkAddress}, {@link #recordAddress}): every request from one client address to a
 *       route this throttle counts (submit, validate, test, pdf, register), whatever form it names. The routes ask it
 *       after the Content-Type check and before they read the body, so a flood of bodies that never parse is counted
 *       too: the per-form key below needs the form, and the form is only known once the body is parsed.</li>
 *   <li>The per-form throttle ({@link #check}, {@link #record}): the receiver calls {@link #check} once the request is
 *       read and the caller may use the form; on {@link ThrottleDecision.Allow} it calls {@link #record} at once, before
 *       any check that may refuse the request, so a request refused later (a stale page, a sandbox rejection, a busy
 *       runtime) counts like any other attempt: a flood of requests that fail later is throttled as surely as one that
 *       succeeds.</li>
 * </ul>
 * The wire order is: Content-Type (415), the address limit (429), the body cap (413), the strict parse (400), the
 * per-form throttle (429), the pre-checks, the run.
 */
public interface SubmissionThrottle {

    /** Whether the key may go on now. Must not count the attempt. */
    ThrottleDecision check(ThrottleKey key);

    /** Counts one attempt by the key. */
    void record(ThrottleKey key);

    /**
     * Whether the client address may send one more request to a route this throttle counts. Must not count the request.
     *
     * <p>The default allows every address: a throttle that keeps no address limit of its own (a gateway in front that
     * already counts by address). A replacement that should keep the limit implements both address methods over its own
     * store, in a key space apart from {@link #check}'s.
     *
     * @param address the address as {@link CountedAddress} counts it (an IPv6 client by its /64), never null: a request
     *     with no client address is not counted
     */
    default ThrottleDecision checkAddress(String address) {
        return ThrottleDecision.ALLOW;
    }

    /** Counts one request from the address ({@link #checkAddress}). The default counts nothing. */
    default void recordAddress(String address) {
    }

    /**
     * The address limit as every route applies it: the address counted as {@link CountedAddress} counts it, checked, and
     * on {@link ThrottleDecision.Allow} recorded at once. A request refused here is not counted, as a per-form refusal
     * is not. No throttle, or a request with no client address, is never refused here.
     *
     * @param throttle the host's throttle, or null for none
     * @param remoteAddress the client address as the request gives it, or null
     * @return the refusal, or null when the request may go on
     */
    static ThrottleDecision.@Nullable Deny admitAddress(@Nullable SubmissionThrottle throttle, @Nullable String remoteAddress) {
        if (throttle == null || remoteAddress == null || remoteAddress.isEmpty()) {
            return null;
        }
        String counted = CountedAddress.of(remoteAddress);
        if (throttle.checkAddress(counted) instanceof ThrottleDecision.Deny deny) {
            return deny;
        }
        throttle.recordAddress(counted);
        return null;
    }
}
