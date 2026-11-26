package com.argusvane.datum.submissions.spi;

import com.argusvane.datum.submissions.spi.ThrottleKey.Caller;
import java.security.Principal;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.TreeMap;
import java.util.regex.Pattern;
import org.jspecify.annotations.Nullable;

/**
 * Who sent a submission and through what, with no transport type in it: what the
 * {@code SubmissionService} and its hooks know of the caller, whether the document came over HTTP, from a JDBC batch,
 * an event-bus consumer, a syncing device or a re-validation of stored records on the current version.
 *
 * <p>The HTTP receiver builds one per request ({@link SubmissionRequest#toContext}): channel {@link #HTTP}, the client
 * address and User-Agent from the request, every header as plain data, the throttle key from the address and the
 * principal's name, and the SHA-256 of the raw body. Another caller builds its own with {@link #of(String)} and the
 * withers; everything but the channel is optional. Nothing here decides access: who may submit at all is the
 * application's (its security in front of a route, or the code that calls the service).
 *
 * @param channel how the document came in: {@code http}, {@code jdbc}, {@code bus}, {@code sync}, {@code other}, or the
 *     caller's own word (1 to 64 letters, digits, {@code .}, {@code _}, {@code :}, {@code /} or {@code -}, starting with
 *     a letter or digit), carried by the events and {@link AcceptedSubmission#channel()}
 * @param principal who is asking, or null when anonymous (or when the channel has no caller identity)
 * @param remoteAddress the client address, or null (a non-HTTP channel usually has none)
 * @param userAgent the client's User-Agent, or null
 * @param headers request headers as plain data, names compared case-insensitively; empty when the channel has none
 * @param throttleKey who the throttle counts this request under, or null for a channel the throttle does not count
 *     (a trusted batch whose own queue is its backpressure); the form and the route kind are added by the service
 * @param bodyDigest SHA-256, lowercase hex, of the bytes the caller received, or null when there were none
 * @param submissionKey the key of the submit attempt a delivery belongs to ({@link #SUBMISSION_KEY}): what the browser
 *     mints once per attempt and sends again on a retry, or what another channel makes the same way (a queue message's
 *     id, a device's own attempt id). A delivery without one is refused; a check or a dry run ignores it
 */
public record SubmissionContext(String channel, @Nullable Principal principal, @Nullable String remoteAddress, @Nullable String userAgent,
                                Map<String, List<String>> headers, @Nullable Caller throttleKey, @Nullable String bodyDigest,
                                @Nullable String submissionKey) {

    /** A request on the HTTP routes. */
    public static final String HTTP = "http";
    /** A document read from a database (a batch import, a re-validation of stored records on the current version). */
    public static final String JDBC = "jdbc";
    /** A message from a queue or an event bus. */
    public static final String BUS = "bus";
    /** A device or replica that syncs answers it took offline. */
    public static final String SYNC = "sync";
    /** Anything else. */
    public static final String OTHER = "other";

    /**
     * What a channel may be called: short enough for a log line or a meter tag and free of spaces and control
     * characters, so a caller's word never breaks either.
     */
    private static final Pattern CHANNEL = Pattern.compile("^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$");

    private static final Pattern SHA256 = Pattern.compile("^[0-9a-f]{64}$");

    /**
     * What a submission key may be: 1 to 128 letters, digits, {@code .}, {@code _}, {@code :} or {@code -}, starting with
     * a letter or digit (a UUID is one), the same rule as {@code @argusvane/datum-submissions}' {@code SUBMISSION_KEY_PATTERN}.
     */
    public static final Pattern SUBMISSION_KEY = Pattern.compile("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$");

    public SubmissionContext {
        Objects.requireNonNull(channel, "channel");
        if (!CHANNEL.matcher(channel).matches()) {
            throw new IllegalArgumentException("A channel is 1 to 64 letters, digits, '.', '_', ':', '/' or '-', starting with a letter or digit.");
        }
        Map<String, List<String>> folded = new TreeMap<>(String.CASE_INSENSITIVE_ORDER);
        if (headers != null) {
            headers.forEach((name, values) -> {
                if (name != null) {
                    folded.put(name, values == null ? List.of() : List.copyOf(values));
                }
            });
        }
        headers = Collections.unmodifiableMap(folded);
        if (bodyDigest != null && !SHA256.matcher(bodyDigest).matches()) {
            throw new IllegalArgumentException("A body digest is a SHA-256 in lowercase hex.");
        }
        if (submissionKey != null && !SUBMISSION_KEY.matcher(submissionKey).matches()) {
            throw new IllegalArgumentException("A submission key is 1 to 128 letters, digits, '.', '_', ':' or '-', starting with a letter or digit.");
        }
    }

    /** A caller on this channel with nothing else known: no principal, no client facts, not throttled, no body digest. */
    public static SubmissionContext of(String channel) {
        return new SubmissionContext(channel, null, null, null, Map.of(), null, null, null);
    }

    /**
     * An HTTP request as the receiver reads it: the User-Agent from the headers and the throttle key from the address
     * and the principal's name, as the routes have always counted.
     *
     * @param remoteAddress the client address after the application's forwarded-header handling, or null
     * @param headers the request headers
     * @param principal who is asking, or null
     * @param bodyDigest SHA-256 of the raw body, or null
     */
    public static SubmissionContext http(@Nullable String remoteAddress, Map<String, List<String>> headers, @Nullable Principal principal,
                                         @Nullable String bodyDigest) {
        SubmissionContext bare = new SubmissionContext(HTTP, principal, remoteAddress, null, headers, null, bodyDigest, null);
        return new SubmissionContext(HTTP, principal, remoteAddress, bare.header("User-Agent"), bare.headers(),
            new ThrottleKey.Caller(remoteAddress, principal == null ? null : principal.getName()), bodyDigest, null);
    }

    /** The same context for this principal. */
    public SubmissionContext withPrincipal(@Nullable Principal principal) {
        return new SubmissionContext(channel, principal, remoteAddress, userAgent, headers, throttleKey, bodyDigest, submissionKey);
    }

    /** The same context with these client facts (either may be null). */
    public SubmissionContext withClient(@Nullable String remoteAddress, @Nullable String userAgent) {
        return new SubmissionContext(channel, principal, remoteAddress, userAgent, headers, throttleKey, bodyDigest, submissionKey);
    }

    /** The same context with these headers (plain data, for a pre-check or a signature check that reads one). */
    public SubmissionContext withHeaders(Map<String, List<String>> headers) {
        return new SubmissionContext(channel, principal, remoteAddress, userAgent, headers, throttleKey, bodyDigest, submissionKey);
    }

    /** The same context, counted by the throttle under this key (null: not counted). */
    public SubmissionContext withThrottleKey(@Nullable Caller throttleKey) {
        return new SubmissionContext(channel, principal, remoteAddress, userAgent, headers, throttleKey, bodyDigest, submissionKey);
    }

    /** The same context with the digest of the bytes the caller received. */
    public SubmissionContext withBodyDigest(@Nullable String bodyDigest) {
        return new SubmissionContext(channel, principal, remoteAddress, userAgent, headers, throttleKey, bodyDigest, submissionKey);
    }

    /** The same context for this submit attempt (null: none, which a delivery is refused for). */
    public SubmissionContext withSubmissionKey(@Nullable String submissionKey) {
        return new SubmissionContext(channel, principal, remoteAddress, userAgent, headers, throttleKey, bodyDigest, submissionKey);
    }

    /** The first value of a header, or null. */
    public @Nullable String header(String name) {
        List<String> values = headers.get(name);
        return values == null || values.isEmpty() ? null : values.get(0);
    }

    /** The principal's name, or null when anonymous. */
    public @Nullable String principalName() {
        return principal == null ? null : principal.getName();
    }
}
