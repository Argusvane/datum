package com.argusvane.datum.webauthn;

import com.argusvane.datum.core.DatumConfigurationException;
import java.util.List;
import java.util.Locale;

/**
 * A form's signing settings, defaults filled in: an unset word (null) is the default and the statement is
 * trimmed. A word that is set and is not one the verifier reads stops the caller rather than falling back to
 * the default, which would turn {@code userVerification("Required")} into {@code preferred} and quietly weaken a form.
 *
 * @param mode off, optional or required
 * @param scope what a signature covers: envelope, submission or values
 * @param placement where signatures land: embedded or wrapper (what the page is told; the verifier reads both)
 * @param userVerification required or preferred
 * @param statement the signing statement ("" for none)
 * @param verify whether a signature that is not valid refuses the submission. An INVALID verdict always refuses
 *     (datum-submissions' SignatureVerdict fails closed), so this only decides for an
 *     unverifiable one
 * @param unavailable refuse or accept a required form's submission from a browser without passkeys
 */
public record FormSigning(Mode mode, String scope, String placement, String userVerification, String statement, boolean verify,
                          String unavailable) {

    /** The form's signing mode. */
    public enum Mode {
        OFF,
        OPTIONAL,
        REQUIRED;

        /** The mode a word names; off for any other word. */
        public static Mode of(String word) {
            if (word == null) {
                return OFF;
            }
            return switch (word.trim().toLowerCase(Locale.ROOT)) {
                case "optional" -> OPTIONAL;
                case "required" -> REQUIRED;
                default -> OFF;
            };
        }
    }

    /** Signing off: the default of every form. */
    public static final FormSigning OFF = builder().build();

    public FormSigning {
        mode = mode == null ? Mode.OFF : mode;
        scope = pick(scope, List.of("envelope", "submission", "values"), "envelope");
        placement = pick(placement, List.of("embedded", "wrapper"), "embedded");
        userVerification = pick(userVerification, List.of("required", "preferred"), "preferred");
        statement = statement == null ? "" : statement.trim();
        unavailable = pick(unavailable, List.of("refuse", "accept"), "refuse");
    }

    private static String pick(String value, List<String> allowed, String fallback) {
        // Unset is null or blank (a property binds an empty value as ""): the default.
        if (value == null || value.isEmpty()) {
            return fallback;
        }
        if (allowed.contains(value)) {
            return value;
        }
        throw new DatumConfigurationException(null, "The signing word '" + value + "' is not one of " + allowed + ".",
            "Use one of " + allowed + " (lower case), or leave the word unset for the default (" + fallback + ").");
    }

    /** Whether the form requires user verification of its signers. */
    public boolean requiresUserVerification() {
        return userVerification.equals("required");
    }

    public static Builder builder() {
        return new Builder();
    }

    /** A builder over the defaults: off, envelope, embedded, preferred, no statement, verify, refuse. */
    public static final class Builder {
        private Mode mode = Mode.OFF;
        private String scope = "envelope";
        private String placement = "embedded";
        private String userVerification = "preferred";
        private String statement = "";
        private boolean verify = true;
        private String unavailable = "refuse";

        private Builder() {
        }

        public Builder mode(Mode value) { mode = value; return this; }
        public Builder scope(String value) { scope = value; return this; }
        public Builder placement(String value) { placement = value; return this; }
        public Builder userVerification(String value) { userVerification = value; return this; }
        public Builder statement(String value) { statement = value; return this; }
        public Builder verify(boolean value) { verify = value; return this; }
        public Builder unavailable(String value) { unavailable = value; return this; }

        public FormSigning build() {
            return new FormSigning(mode, scope, placement, userVerification, statement, verify, unavailable);
        }
    }
}
