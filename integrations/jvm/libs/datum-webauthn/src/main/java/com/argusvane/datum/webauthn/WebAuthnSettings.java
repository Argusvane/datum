package com.argusvane.datum.webauthn;

import com.argusvane.datum.core.DatumConfigurationException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * The site's passkey settings: the relying party, the origins a
 * client may write, the signing window, whether anonymous visitors may make and sign with passkeys, and whether
 * passkeys are per form.
 *
 * <p>Nothing is derived from the request's Host, which a client controls: the passkey domain and origins are
 * configured or passkeys are not set up ({@link #ready()} false).
 *
 * @param rpId the passkey domain (relying party id), lower case; "" when passkeys are not set up
 * @param rpName the relying party's name the browser shows
 * @param origins the origins the client data may name, exactly (scheme, host and port), without a trailing slash
 * @param window how old a signature's (client-claimed) signing time may be when it arrives; 600 s by default
 * @param anonymous whether anonymous visitors may make passkeys and sign
 * @param perForm whether a passkey made at a form signs that form alone
 * @param residentKey the {@code residentKey} requirement a registration asks the authenticator for: {@code required} (the default: a
 *     passkey the browser can offer without being told which), {@code preferred} or {@code discouraged}
 * @param challengeSkew how far ahead of this server's clock a registration challenge's issue time may be (another server's clock); 0 to 5 minutes, 60 s by default
 * @param signedAtSkew how far apart a signature's two client-claimed signing times may be; 0 to 10 minutes, 60 s by default
 * @param anonymousGrace how long an anonymous passkey that signed nothing is kept before the purge removes it; 1 hour to 30 days, 24 hours by default
 */
public record WebAuthnSettings(String rpId, String rpName, List<String> origins, Duration window, boolean anonymous, boolean perForm,
                               String residentKey, Duration challengeSkew, Duration signedAtSkew, Duration anonymousGrace) {
    // Copies: one component changed, the rest kept; the canonical constructor
    // checks the result, so a copy cannot hold what a new value could not. Replaces a positional constructor call that
    // breaks whenever a component is added.

    /** A copy with {@code rpId} replaced and every other component kept. */
    public WebAuthnSettings withRpId(String value) {
        return new WebAuthnSettings(value, rpName, origins, window, anonymous, perForm, residentKey, challengeSkew, signedAtSkew, anonymousGrace);
    }

    /** A copy with {@code rpName} replaced and every other component kept. */
    public WebAuthnSettings withRpName(String value) {
        return new WebAuthnSettings(rpId, value, origins, window, anonymous, perForm, residentKey, challengeSkew, signedAtSkew, anonymousGrace);
    }

    /** A copy with {@code origins} replaced and every other component kept. */
    public WebAuthnSettings withOrigins(List<String> value) {
        return new WebAuthnSettings(rpId, rpName, value, window, anonymous, perForm, residentKey, challengeSkew, signedAtSkew, anonymousGrace);
    }

    /** A copy with {@code window} replaced and every other component kept. */
    public WebAuthnSettings withWindow(Duration value) {
        return new WebAuthnSettings(rpId, rpName, origins, value, anonymous, perForm, residentKey, challengeSkew, signedAtSkew, anonymousGrace);
    }

    /** A copy with {@code anonymous} replaced and every other component kept. */
    public WebAuthnSettings withAnonymous(boolean value) {
        return new WebAuthnSettings(rpId, rpName, origins, window, value, perForm, residentKey, challengeSkew, signedAtSkew, anonymousGrace);
    }

    /** A copy with {@code perForm} replaced and every other component kept. */
    public WebAuthnSettings withPerForm(boolean value) {
        return new WebAuthnSettings(rpId, rpName, origins, window, anonymous, value, residentKey, challengeSkew, signedAtSkew, anonymousGrace);
    }

    /** A copy with {@code residentKey} replaced and every other component kept. */
    public WebAuthnSettings withResidentKey(String value) {
        return new WebAuthnSettings(rpId, rpName, origins, window, anonymous, perForm, value, challengeSkew, signedAtSkew, anonymousGrace);
    }

    /** A copy with {@code challengeSkew} replaced and every other component kept. */
    public WebAuthnSettings withChallengeSkew(Duration value) {
        return new WebAuthnSettings(rpId, rpName, origins, window, anonymous, perForm, residentKey, value, signedAtSkew, anonymousGrace);
    }

    /** A copy with {@code signedAtSkew} replaced and every other component kept. */
    public WebAuthnSettings withSignedAtSkew(Duration value) {
        return new WebAuthnSettings(rpId, rpName, origins, window, anonymous, perForm, residentKey, challengeSkew, value, anonymousGrace);
    }

    /** A copy with {@code anonymousGrace} replaced and every other component kept. */
    public WebAuthnSettings withAnonymousGrace(Duration value) {
        return new WebAuthnSettings(rpId, rpName, origins, window, anonymous, perForm, residentKey, challengeSkew, signedAtSkew, value);
    }

    /** The default signing window: ten minutes between the client's signing time and the signature's arrival. */
    public static final Duration WINDOW = Duration.ofSeconds(600);

    public static final String DEFAULT_RESIDENT_KEY = "required";
    public static final Duration DEFAULT_CHALLENGE_SKEW = Duration.ofSeconds(60);
    public static final Duration MAX_CHALLENGE_SKEW = Duration.ofMinutes(5);
    public static final Duration DEFAULT_SIGNED_AT_SKEW = Duration.ofSeconds(60);
    public static final Duration MAX_SIGNED_AT_SKEW = Duration.ofMinutes(10);
    public static final Duration DEFAULT_ANONYMOUS_GRACE = Duration.ofHours(24);
    public static final Duration MIN_ANONYMOUS_GRACE = Duration.ofHours(1);
    public static final Duration MAX_ANONYMOUS_GRACE = Duration.ofDays(30);

    public WebAuthnSettings {
        rpId = rpId == null ? "" : rpId.trim().toLowerCase(Locale.ROOT);
        rpName = rpName == null ? "" : rpName;
        List<String> cleaned = new ArrayList<>();
        if (origins != null) {
            for (String origin : origins) {
                String trimmed = origin == null ? "" : origin.trim();
                while (trimmed.endsWith("/")) {
                    trimmed = trimmed.substring(0, trimmed.length() - 1);
                }
                if (!trimmed.isEmpty()) {
                    cleaned.add(trimmed);
                }
            }
        }
        origins = List.copyOf(cleaned);
        // Unset is the default; a set window is whole seconds, at least one (a window that cannot work stops
        // the start naming the property).
        if (window == null) {
            window = WINDOW;
        } else if (window.getSeconds() < 1) {
            throw new DatumConfigurationException("datum.webauthn.window", "datum.webauthn.window is " + window + "; it must be at least one second.");
        } else {
            window = Duration.ofSeconds(window.getSeconds());
        }
        // Words and durations that a typo would turn into something quieter stop the start, naming the property.
        String word = residentKey == null || residentKey.isBlank() ? DEFAULT_RESIDENT_KEY : residentKey.strip().toLowerCase(Locale.ROOT);
        if (!(word.equals("required") || word.equals("preferred") || word.equals("discouraged"))) {
            throw new DatumConfigurationException("datum.webauthn.resident-key", "datum.webauthn.resident-key is required, preferred or discouraged, not \"" + residentKey + "\".");
        }
        residentKey = word;
        challengeSkew = wholeSeconds("datum.webauthn.challenge-skew", challengeSkew, DEFAULT_CHALLENGE_SKEW, Duration.ZERO, MAX_CHALLENGE_SKEW);
        signedAtSkew = wholeSeconds("datum.webauthn.signed-at-skew", signedAtSkew, DEFAULT_SIGNED_AT_SKEW, Duration.ZERO, MAX_SIGNED_AT_SKEW);
        anonymousGrace = wholeSeconds("datum.webauthn.anonymous-grace", anonymousGrace, DEFAULT_ANONYMOUS_GRACE, MIN_ANONYMOUS_GRACE,
            MAX_ANONYMOUS_GRACE);
    }

    private static Duration wholeSeconds(String property, Duration value, Duration fallback, Duration min, Duration max) {
        if (value == null) {
            return fallback;
        }
        if (value.compareTo(min) < 0 || value.compareTo(max) > 0) {
            throw new IllegalArgumentException(property + " is " + value + "; it must be from " + min + " to " + max + ".");
        }
        return Duration.ofSeconds(value.getSeconds());
    }

    /** Whether passkeys are set up: a passkey domain and origins to check. */
    public boolean ready() {
        return !rpId.isEmpty() && !origins.isEmpty();
    }

    /** Whether someone may make passkeys and sign: anyone signed in, a visitor when {@link #anonymous()}. */
    public boolean maySign(PasskeySubject subject) {
        return !subject.isAnonymous() || anonymous;
    }
}
