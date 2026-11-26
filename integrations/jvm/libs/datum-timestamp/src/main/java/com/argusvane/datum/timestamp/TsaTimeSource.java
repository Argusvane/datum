package com.argusvane.datum.timestamp;

import java.time.Clock;
import java.time.Instant;
import java.util.Objects;

/**
 * Where the timestamp server gets "now", and whether it may trust it (RFC 3161 section 2.4.2: a TSA whose time
 * source is not available must refuse with {@code timeNotAvailable}, and its clock must be within the stated
 * accuracy of UTC). The default wraps a {@link Clock} and is always available; an operator who wants the server
 * to stop issuing when the system clock has drifted supplies a source that compares it with a reference (an NTP
 * check, a GPS receiver, a hardware clock) and answers {@link Reading#unavailable} above its drift.
 *
 * <p>Datum builds no NTP client: an NTP source is one implementation of this interface, for example with Apache Commons Net, and the
 * monitor pattern (check the clock against a reference, refuse above a configured drift) is SignServer's
 * {@code TimeMonitor}.
 *
 * <p>{@link #read()} runs on every request and on every health check, so a source answers from a cached reading
 * that a background task refreshes; it must not block on the network. A source that throws is read as unavailable.
 */
@FunctionalInterface
public interface TsaTimeSource {

    /** One reading of the time source. */
    sealed interface Reading permits Available, Unavailable {

        /** The time is trustworthy: this is now. */
        static Reading available(Instant now) {
            return new Available(Objects.requireNonNull(now, "now"));
        }

        /**
         * The time cannot be trusted now; the reason goes to the client in the refusal's statusString and to the
         * health check, so it must not carry anything the operator would keep private.
         */
        static Reading unavailable(String reason) {
            return new Unavailable(reason == null || reason.isBlank() ? "no reason given" : clean(reason.strip()));
        }
    }

    /**
     * The reason as the statusString can carry it: capped at 200 characters, and an unpaired surrogate (a truncated
     * exception message) replaced, because the DER UTF8String refuses it and the refusal would never be written.
     */
    private static String clean(String reason) {
        String capped = reason.length() > 200 ? reason.substring(0, 200) : reason;
        StringBuilder out = new StringBuilder(capped.length());
        for (int i = 0; i < capped.length(); i++) {
            char c = capped.charAt(i);
            if (Character.isHighSurrogate(c) && i + 1 < capped.length() && Character.isLowSurrogate(capped.charAt(i + 1))) {
                out.append(c).append(capped.charAt(++i));
            } else if (Character.isSurrogate(c)) {
                out.append('?');
            } else {
                out.append(c);
            }
        }
        return out.toString();
    }

    /** A trustworthy time. */
    record Available(Instant now) implements Reading {
    }

    /** No trustworthy time, and why. */
    record Unavailable(String reason) implements Reading {
    }

    /** The reading now. */
    Reading read();

    /** The default: a clock, always available. */
    static TsaTimeSource of(Clock clock) {
        Objects.requireNonNull(clock, "clock");
        return () -> Reading.available(clock.instant());
    }
}
