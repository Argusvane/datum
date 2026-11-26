package com.argusvane.datum.submissions.spi;

import java.security.Principal;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import org.jspecify.annotations.Nullable;

/**
 * What the HTTP receiver may read of the request, with no servlet or reactive type in it: the web adapters build one
 * per request, so the receiver is one implementation for MVC and WebFlux. The hooks see the
 * transport-neutral {@link SubmissionContext} the receiver makes of it ({@link #toContext}), never this view.
 *
 * @param contentType the Content-Type as sent, or null
 * @param headers the request headers, names compared case-insensitively
 * @param remoteAddress the client address after Spring's {@code ForwardedHeaderFilter} (when the application
 *     enables it behind a proxy), or null
 * @param principal who is asking, or null when anonymous: the throttle's key, the hooks' and the accepted
 *     submission's client facts; Datum itself makes no access decision with it (that is the application's
 *     security), the pre-checks get it to make one per form
 */
public record SubmissionRequest(@Nullable String contentType, Map<String, List<String>> headers, @Nullable String remoteAddress,
                                @Nullable Principal principal) {

    public SubmissionRequest {
        Map<String, List<String>> folded = new TreeMap<>(String.CASE_INSENSITIVE_ORDER);
        if (headers != null) {
            headers.forEach((name, values) -> {
                if (name != null) {
                    folded.put(name, values == null ? List.of() : List.copyOf(values));
                }
            });
        }
        headers = Collections.unmodifiableMap(folded);
    }

    /** A JSON request from nowhere in particular, for tests and background calls. */
    public static SubmissionRequest json() {
        return new SubmissionRequest("application/json", Map.of(), null, null);
    }

    /**
     * What the submission service and its hooks see of this request: channel {@code http}, the client address, the
     * User-Agent, the headers, the throttle key (address and principal's name, as the routes count) and the body digest.
     *
     * @param bodyDigest SHA-256, lowercase hex, of the raw body, or null
     */
    public SubmissionContext toContext(@Nullable String bodyDigest) {
        return SubmissionContext.http(remoteAddress, headers, principal, bodyDigest);
    }

    /** The first value of a header, or null. */
    public @Nullable String header(String name) {
        List<String> values = headers.get(name);
        return values == null || values.isEmpty() ? null : values.get(0);
    }

    /** The User-Agent header, or null. */
    public @Nullable String userAgent() {
        return header("User-Agent");
    }

    /** The principal's name, or null when anonymous. */
    public @Nullable String principalName() {
        return principal == null ? null : principal.getName();
    }
}
