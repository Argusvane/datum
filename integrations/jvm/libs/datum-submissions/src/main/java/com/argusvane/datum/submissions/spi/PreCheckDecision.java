package com.argusvane.datum.submissions.spi;

import java.util.Objects;
import java.util.regex.Pattern;
import org.jspecify.annotations.Nullable;

/** A pre-check's answer: go on, or refuse with a code. */
public sealed interface PreCheckDecision permits PreCheckDecision.Allow, PreCheckDecision.Reject {

    /** The one "go on". */
    Allow ALLOW = new Allow();

    /** Go on. */
    record Allow() implements PreCheckDecision {
    }

    /**
     * Refused before anything is judged: a machine code and the words for the person, with no transport in it. The HTTP receiver answers {@code {errors: [{field: null, code, message?}]}} with
     * the status its {@code PreCheckStatuses} names for the code: 403 for every code by default,
     * or what the application opts into ({@code PreCheckStatuses.bySuffix()}: 422 for a code ending {@code .invalid},
     * 503 for {@code .unavailable}, an anti-spam service that is down; or its own mapping); another caller of the
     * submission service reads the code.
     *
     * @param code the machine code ({@code spam.honeypot}, say): a letter, then letters, digits, {@code .}, {@code _},
     *     {@code :} or {@code -}, at most 128
     * @param message host-worded text for the person, or null
     */
    record Reject(String code, @Nullable String message) implements PreCheckDecision {

        private static final Pattern CODE = Pattern.compile("[A-Za-z][A-Za-z0-9._:-]{0,127}");

        public Reject {
            Objects.requireNonNull(code, "code");
            if (!CODE.matcher(code).matches()) {
                throw new IllegalArgumentException("A refusal's code is a letter, then letters, digits, '.', '_', ':' or '-', at most 128: \"" + code + "\".");
            }
        }

        /** A refusal with no message (403 under the receiver's standard mapping). */
        public static Reject of(String code) {
            return new Reject(code, null);
        }
    }
}
