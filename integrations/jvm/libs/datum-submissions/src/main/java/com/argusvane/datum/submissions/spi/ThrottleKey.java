package com.argusvane.datum.submissions.spi;

import java.util.Objects;
import org.jspecify.annotations.Nullable;

/**
 * Who is asking for what, as a throttle counts it.
 *
 * <p>The {@code channel} is the {@link SubmissionContext#channel()} the request came in on ({@code http} for
 * the routes, the four-argument constructor's value), so a throttle may count a bus apart from the web. The development
 * throttle does not: it counts by the parts {@code datum.web.throttle.by} names and the kind.
 *
 * @param ip the client address, or null when unknown; the service and the PDF route name it as
 *     {@link com.argusvane.datum.core.CountedAddress} counts it (an IPv6 client by its /64)
 * @param formKey the form, or null when the route names none
 * @param principal the principal's name, or null when anonymous
 * @param kind which route
 * @param channel how the request came in ({@code http} for every route)
 */
public record ThrottleKey(@Nullable String ip, @Nullable String formKey, @Nullable String principal, Kind kind, String channel) {

    /** The routes a throttle tells apart. */
    public enum Kind {
        SUBMIT,
        VALIDATE,
        TEST,
        PDF,
        REGISTER
    }

    /**
     * The part of a key the caller builds: who is counted. The {@code SubmissionService} adds the form the
     * document names, the kind of the call and the context's channel. The HTTP receiver builds it from the client address
     * and the principal's name ({@link SubmissionContext#http}); another channel names its own (a device id as
     * {@code principal}, say) or none.
     *
     * @param ip the client address, or null
     * @param principal the name the throttle counts the caller by, or null
     */
    public record Caller(@Nullable String ip, @Nullable String principal) {
    }

    public ThrottleKey {
        Objects.requireNonNull(kind, "kind");
        Objects.requireNonNull(channel, "channel");
    }

    /** A key on the HTTP routes: the PDF facade's and the passkey registration's, and any key that names no channel. */
    public ThrottleKey(@Nullable String ip, @Nullable String formKey, @Nullable String principal, Kind kind) {
        this(ip, formKey, principal, kind, SubmissionContext.HTTP);
    }

    /** The kind the receiver counts a mode under. */
    public static Kind kindOf(SubmissionMode mode) {
        return switch (mode) {
            case SUBMIT -> Kind.SUBMIT;
            case VALIDATE -> Kind.VALIDATE;
            case TEST -> Kind.TEST;
            case PDF -> Kind.PDF;
        };
    }
}
