package com.argusvane.datum.submissions.receiver;

import com.argusvane.datum.core.DatumException;
import com.argusvane.datum.web.error.ErrorDetails;
import com.argusvane.datum.web.error.ErrorItem;
import java.time.Duration;
import java.util.List;
import java.util.Map;

/**
 * Too many requests from one key: 429 {@code flood} with {@code Retry-After} in whole seconds. The code and words
 * are the wire's (endpoint catalog), which the conformance suite's REC-14 and the page glue read;
 * the code is {@code flood}, never a shorthand such as {@code throttled}.
 */
public class ThrottledException extends DatumException implements ErrorDetails {

    private static final long serialVersionUID = 1L;

    public static final String CODE = "flood";

    private final Duration retryAfter;

    public ThrottledException(Duration retryAfter) {
        super(CODE, 429, "Too many submissions from your address. Try again later.");
        this.retryAfter = retryAfter == null || retryAfter.isNegative() ? Duration.ZERO : retryAfter;
    }

    /** How long the caller waits. */
    public Duration retryAfter() {
        return retryAfter;
    }

    /** The header value: whole seconds, rounded up, at least one. */
    public long retryAfterSeconds() {
        long seconds = retryAfter.toSeconds() + (retryAfter.toNanosPart() > 0 ? 1 : 0);
        return Math.max(1, seconds);
    }

    @Override
    public List<ErrorItem> errorItems() {
        return List.of();
    }

    @Override
    public Map<String, String> responseHeaders() {
        return Map.of("Retry-After", Long.toString(retryAfterSeconds()));
    }
}
