package com.argusvane.datum.webauthn.web;

import com.argusvane.datum.core.DatumException;
import com.argusvane.datum.web.error.ErrorDetails;
import com.argusvane.datum.web.error.ErrorItem;
import java.time.Duration;
import java.util.List;
import java.util.Map;

/** 429 {@code flood} with {@code Retry-After}, in the passkey endpoints' words (REC-14's code). */
public class PasskeyThrottledException extends DatumException implements ErrorDetails {

    private static final long serialVersionUID = 1L;

    private final transient Duration retryAfter;

    public PasskeyThrottledException(Duration retryAfter) {
        super("flood", 429, "Too many passkey requests from your address. Try again later.");
        this.retryAfter = retryAfter == null || retryAfter.isNegative() ? Duration.ZERO : retryAfter;
    }

    /** Whole seconds, at least one. */
    public long retryAfterSeconds() {
        return Math.max(1, retryAfter.toSeconds() + (retryAfter.toNanosPart() > 0 ? 1 : 0));
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
