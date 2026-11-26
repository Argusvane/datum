package com.argusvane.datum.timestamp.web;

import com.argusvane.datum.timestamp.TimestampRefusal;

/**
 * Published after the timestamp endpoint answered a request with a rejection (a TimeStampResp, status 400 or
 * 503); not for the plain-text refusals that come before a request is read (415, 401, 403, 413, 429).
 *
 * <p>Delivery: synchronously on the request thread, with Spring's default multicaster, after the reply is
 * built and before it is sent; the serial is spent by then (in its own write, no transaction of the request). A listener
 * that throws is logged and the reply is sent all the same; it cannot veto.
 *
 * @param failInfo the PKIFailureInfo bit the reply states ({@code TimestampRefusal.FAIL_*})
 * @param reason the statusString the reply carries
 */
public record TimestampRefusedEvent(int failInfo, String reason) {

    /** The failure's name as RFC 3161 spells it ({@code badAlg}, {@code systemFailure}, ...). */
    public String failName() {
        return new TimestampRefusal(failInfo, reason).failName();
    }
}
