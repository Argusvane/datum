package com.argusvane.datum.webauthn;

import com.argusvane.datum.core.DatumConfigurationException;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * {@code datum.webauthn.*}: passkey registration and passkey-signed submissions (the site's signing settings
 * and each form's), as one framework-free value
 * with the checks a host's start runs.
 * Spring's {@code DatumWebAuthnProperties} and a Quarkus config mapping would also map onto it.
 *
 * <p>Named {@code PasskeySettings} because {@link WebAuthnSettings} already names the ceremony's narrower record
 * (relying party, origins, window, anonymous, per form), which {@link #webAuthnSettings} derives from this one.
 *
 * @param enabled           turn passkeys on
 * @param rpId              the relying-party id: the registrable domain passkeys are bound to; empty means not set up
 * @param rpName            the name the browser shows for the site; empty means the application's name, else the rp-id
 * @param origins           the origins a client may write, exactly: scheme, host and port, no path
 * @param anonymous         let visitors who are not signed in make passkeys and sign
 * @param registerAtSubmit  let people register a passkey when they submit a form
 * @param window            how long a signature may take to arrive (whole seconds, at least one)
 * @param challengeTtl      how long a registration challenge holds: 10 seconds to an hour
 * @param path              the base path of the endpoints, one leading slash, no trailing slash
 * @param passkeys          passkeys sign for every form or only the one they were made on
 * @param secret            the HMAC key of registration challenges, at least 32 bytes; empty: one is made at start
 * @param labelPath         the answer (value path) that names a visitor's passkey, told to the page
 * @param keepYears         years signed submissions are kept at least (0: retention decides)
 * @param siteSigning       the form defaults ({@code mode}, {@code scope}, ...); every member set
 * @param forms             per-form overrides of the defaults, by form key; a member left null keeps the default
 * @param allowMemoryStores acknowledge single-instance use of the in-memory stores
 * @param residentKey       {@code datum.webauthn.resident-key}: required (default), preferred or discouraged
 * @param challengeSkew     {@code datum.webauthn.challenge-skew}: how far ahead of the server's clock a challenge's issue time may be (60 s)
 * @param signedAtSkew      {@code datum.webauthn.signed-at-skew}: how far apart a signature's two signing times may be (60 s)
 * @param anonymousGrace    {@code datum.webauthn.anonymous-grace}: how long an unused anonymous passkey is kept (24 h)
 */
public record PasskeySettings(boolean enabled, String rpId, String rpName, List<String> origins, boolean anonymous, boolean registerAtSubmit,
                              Duration window, Duration challengeTtl, String path, Passkeys passkeys, String secret, String labelPath, int keepYears,
                              FormSettings siteSigning, Map<String, FormSettings> forms, boolean allowMemoryStores,
                              String residentKey, Duration challengeSkew, Duration signedAtSkew, Duration anonymousGrace) {
    // Copies: one component changed, the rest kept; the canonical constructor
    // checks the result, so a copy cannot hold what a new value could not. Replaces a positional constructor call that
    // breaks whenever a component is added.

    /** A copy with {@code enabled} replaced and every other component kept. */
    public PasskeySettings withEnabled(boolean value) {
        return new PasskeySettings(value, rpId, rpName, origins, anonymous, registerAtSubmit, window, challengeTtl, path, passkeys, secret, labelPath, keepYears, siteSigning, forms, allowMemoryStores, residentKey, challengeSkew, signedAtSkew, anonymousGrace);
    }

    /** A copy with {@code rpId} replaced and every other component kept. */
    public PasskeySettings withRpId(String value) {
        return new PasskeySettings(enabled, value, rpName, origins, anonymous, registerAtSubmit, window, challengeTtl, path, passkeys, secret, labelPath, keepYears, siteSigning, forms, allowMemoryStores, residentKey, challengeSkew, signedAtSkew, anonymousGrace);
    }

    /** A copy with {@code rpName} replaced and every other component kept. */
    public PasskeySettings withRpName(String value) {
        return new PasskeySettings(enabled, rpId, value, origins, anonymous, registerAtSubmit, window, challengeTtl, path, passkeys, secret, labelPath, keepYears, siteSigning, forms, allowMemoryStores, residentKey, challengeSkew, signedAtSkew, anonymousGrace);
    }

    /** A copy with {@code origins} replaced and every other component kept. */
    public PasskeySettings withOrigins(List<String> value) {
        return new PasskeySettings(enabled, rpId, rpName, value, anonymous, registerAtSubmit, window, challengeTtl, path, passkeys, secret, labelPath, keepYears, siteSigning, forms, allowMemoryStores, residentKey, challengeSkew, signedAtSkew, anonymousGrace);
    }

    /** A copy with {@code anonymous} replaced and every other component kept. */
    public PasskeySettings withAnonymous(boolean value) {
        return new PasskeySettings(enabled, rpId, rpName, origins, value, registerAtSubmit, window, challengeTtl, path, passkeys, secret, labelPath, keepYears, siteSigning, forms, allowMemoryStores, residentKey, challengeSkew, signedAtSkew, anonymousGrace);
    }

    /** A copy with {@code registerAtSubmit} replaced and every other component kept. */
    public PasskeySettings withRegisterAtSubmit(boolean value) {
        return new PasskeySettings(enabled, rpId, rpName, origins, anonymous, value, window, challengeTtl, path, passkeys, secret, labelPath, keepYears, siteSigning, forms, allowMemoryStores, residentKey, challengeSkew, signedAtSkew, anonymousGrace);
    }

    /** A copy with {@code window} replaced and every other component kept. */
    public PasskeySettings withWindow(Duration value) {
        return new PasskeySettings(enabled, rpId, rpName, origins, anonymous, registerAtSubmit, value, challengeTtl, path, passkeys, secret, labelPath, keepYears, siteSigning, forms, allowMemoryStores, residentKey, challengeSkew, signedAtSkew, anonymousGrace);
    }

    /** A copy with {@code challengeTtl} replaced and every other component kept. */
    public PasskeySettings withChallengeTtl(Duration value) {
        return new PasskeySettings(enabled, rpId, rpName, origins, anonymous, registerAtSubmit, window, value, path, passkeys, secret, labelPath, keepYears, siteSigning, forms, allowMemoryStores, residentKey, challengeSkew, signedAtSkew, anonymousGrace);
    }

    /** A copy with {@code path} replaced and every other component kept. */
    public PasskeySettings withPath(String value) {
        return new PasskeySettings(enabled, rpId, rpName, origins, anonymous, registerAtSubmit, window, challengeTtl, value, passkeys, secret, labelPath, keepYears, siteSigning, forms, allowMemoryStores, residentKey, challengeSkew, signedAtSkew, anonymousGrace);
    }

    /** A copy with {@code passkeys} replaced and every other component kept. */
    public PasskeySettings withPasskeys(Passkeys value) {
        return new PasskeySettings(enabled, rpId, rpName, origins, anonymous, registerAtSubmit, window, challengeTtl, path, value, secret, labelPath, keepYears, siteSigning, forms, allowMemoryStores, residentKey, challengeSkew, signedAtSkew, anonymousGrace);
    }

    /** A copy with {@code secret} replaced and every other component kept. */
    public PasskeySettings withSecret(String value) {
        return new PasskeySettings(enabled, rpId, rpName, origins, anonymous, registerAtSubmit, window, challengeTtl, path, passkeys, value, labelPath, keepYears, siteSigning, forms, allowMemoryStores, residentKey, challengeSkew, signedAtSkew, anonymousGrace);
    }

    /** A copy with {@code labelPath} replaced and every other component kept. */
    public PasskeySettings withLabelPath(String value) {
        return new PasskeySettings(enabled, rpId, rpName, origins, anonymous, registerAtSubmit, window, challengeTtl, path, passkeys, secret, value, keepYears, siteSigning, forms, allowMemoryStores, residentKey, challengeSkew, signedAtSkew, anonymousGrace);
    }

    /** A copy with {@code keepYears} replaced and every other component kept. */
    public PasskeySettings withKeepYears(int value) {
        return new PasskeySettings(enabled, rpId, rpName, origins, anonymous, registerAtSubmit, window, challengeTtl, path, passkeys, secret, labelPath, value, siteSigning, forms, allowMemoryStores, residentKey, challengeSkew, signedAtSkew, anonymousGrace);
    }

    /** A copy with {@code siteSigning} replaced and every other component kept. */
    public PasskeySettings withSiteSigning(FormSettings value) {
        return new PasskeySettings(enabled, rpId, rpName, origins, anonymous, registerAtSubmit, window, challengeTtl, path, passkeys, secret, labelPath, keepYears, value, forms, allowMemoryStores, residentKey, challengeSkew, signedAtSkew, anonymousGrace);
    }

    /** A copy with {@code forms} replaced and every other component kept. */
    public PasskeySettings withForms(Map<String, FormSettings> value) {
        return new PasskeySettings(enabled, rpId, rpName, origins, anonymous, registerAtSubmit, window, challengeTtl, path, passkeys, secret, labelPath, keepYears, siteSigning, value, allowMemoryStores, residentKey, challengeSkew, signedAtSkew, anonymousGrace);
    }

    /** A copy with {@code allowMemoryStores} replaced and every other component kept. */
    public PasskeySettings withAllowMemoryStores(boolean value) {
        return new PasskeySettings(enabled, rpId, rpName, origins, anonymous, registerAtSubmit, window, challengeTtl, path, passkeys, secret, labelPath, keepYears, siteSigning, forms, value, residentKey, challengeSkew, signedAtSkew, anonymousGrace);
    }

    /** A copy with {@code residentKey} replaced and every other component kept. */
    public PasskeySettings withResidentKey(String value) {
        return new PasskeySettings(enabled, rpId, rpName, origins, anonymous, registerAtSubmit, window, challengeTtl, path, passkeys, secret, labelPath, keepYears, siteSigning, forms, allowMemoryStores, value, challengeSkew, signedAtSkew, anonymousGrace);
    }

    /** A copy with {@code challengeSkew} replaced and every other component kept. */
    public PasskeySettings withChallengeSkew(Duration value) {
        return new PasskeySettings(enabled, rpId, rpName, origins, anonymous, registerAtSubmit, window, challengeTtl, path, passkeys, secret, labelPath, keepYears, siteSigning, forms, allowMemoryStores, residentKey, value, signedAtSkew, anonymousGrace);
    }

    /** A copy with {@code signedAtSkew} replaced and every other component kept. */
    public PasskeySettings withSignedAtSkew(Duration value) {
        return new PasskeySettings(enabled, rpId, rpName, origins, anonymous, registerAtSubmit, window, challengeTtl, path, passkeys, secret, labelPath, keepYears, siteSigning, forms, allowMemoryStores, residentKey, challengeSkew, value, anonymousGrace);
    }

    /** A copy with {@code anonymousGrace} replaced and every other component kept. */
    public PasskeySettings withAnonymousGrace(Duration value) {
        return new PasskeySettings(enabled, rpId, rpName, origins, anonymous, registerAtSubmit, window, challengeTtl, path, passkeys, secret, labelPath, keepYears, siteSigning, forms, allowMemoryStores, residentKey, challengeSkew, signedAtSkew, value);
    }

    private static final Logger LOG = LoggerFactory.getLogger("datum.webauthn");

    /** Where passkeys sign: every form, or only the form they were made at. */
    public enum Passkeys {
        SITE,
        FORM
    }

    /** {@code /api/webauthn}. */
    public static final String DEFAULT_PATH = "/api/webauthn";

    /**
     * One form's signing settings: at the site level every member is set, per form a member left null keeps the
     * site's value.
     */
    public record FormSettings(@Nullable String mode, @Nullable String scope, @Nullable String placement, @Nullable String userVerification,
                               @Nullable String statement, @Nullable Boolean verify, @Nullable String unavailable) {
    // Copies: one component changed, the rest kept; the canonical constructor
    // checks the result, so a copy cannot hold what a new value could not. Replaces a positional constructor call that
    // breaks whenever a component is added.

    /** A copy with {@code mode} replaced and every other component kept. */
    public FormSettings withMode(@Nullable String value) {
        return new FormSettings(value, scope, placement, userVerification, statement, verify, unavailable);
    }

    /** A copy with {@code scope} replaced and every other component kept. */
    public FormSettings withScope(@Nullable String value) {
        return new FormSettings(mode, value, placement, userVerification, statement, verify, unavailable);
    }

    /** A copy with {@code placement} replaced and every other component kept. */
    public FormSettings withPlacement(@Nullable String value) {
        return new FormSettings(mode, scope, value, userVerification, statement, verify, unavailable);
    }

    /** A copy with {@code userVerification} replaced and every other component kept. */
    public FormSettings withUserVerification(@Nullable String value) {
        return new FormSettings(mode, scope, placement, value, statement, verify, unavailable);
    }

    /** A copy with {@code statement} replaced and every other component kept. */
    public FormSettings withStatement(@Nullable String value) {
        return new FormSettings(mode, scope, placement, userVerification, value, verify, unavailable);
    }

    /** A copy with {@code verify} replaced and every other component kept. */
    public FormSettings withVerify(@Nullable Boolean value) {
        return new FormSettings(mode, scope, placement, userVerification, statement, value, unavailable);
    }

    /** A copy with {@code unavailable} replaced and every other component kept. */
    public FormSettings withUnavailable(@Nullable String value) {
        return new FormSettings(mode, scope, placement, userVerification, statement, verify, value);
    }

        /** The site defaults: off, envelope, embedded, preferred, no statement, verify, refuse. */
        public static FormSettings siteDefaults() {
            return new FormSettings("off", "envelope", "embedded", "preferred", "", true, "refuse");
        }

        /** No override at all. */
        public static FormSettings none() {
            return new FormSettings(null, null, null, null, null, null, null);
        }
    }

    public PasskeySettings {
        rpId = rpId == null ? "" : rpId;
        rpName = rpName == null ? "" : rpName;
        origins = origins == null ? List.of() : List.copyOf(origins);
        window = window == null ? WebAuthnSettings.WINDOW : window;
        // 0 means "retention decides", so a negative typo must not quietly become it: the evidence floor would vanish.
        if (keepYears < 0 || keepYears > 100) {
            throw new DatumConfigurationException("datum.webauthn.keep-years", "datum.webauthn.keep-years must be between 0 and 100, not " + keepYears + ".");
        }
        challengeTtl = challengeTtl == null ? PasskeyChallenges.LIFETIME : challengeTtl;
        path = normalisePath(path);
        passkeys = passkeys == null ? Passkeys.SITE : passkeys;
        secret = secret == null ? "" : secret;
        labelPath = labelPath == null ? "" : labelPath;
        siteSigning = siteSigning == null ? FormSettings.siteDefaults() : siteSigning;
        forms = forms == null ? Map.of() : java.util.Collections.unmodifiableMap(new LinkedHashMap<>(forms));
        residentKey = residentKey == null ? WebAuthnSettings.DEFAULT_RESIDENT_KEY : residentKey;
        challengeSkew = challengeSkew == null ? WebAuthnSettings.DEFAULT_CHALLENGE_SKEW : challengeSkew;
        signedAtSkew = signedAtSkew == null ? WebAuthnSettings.DEFAULT_SIGNED_AT_SKEW : signedAtSkew;
        anonymousGrace = anonymousGrace == null ? WebAuthnSettings.DEFAULT_ANONYMOUS_GRACE : anonymousGrace;
    }

    /** What a host that set nothing runs with: passkeys off and not set up. */
    public static PasskeySettings defaults() {
        return new PasskeySettings(false, "", "", List.of(), false, true, WebAuthnSettings.WINDOW, PasskeyChallenges.LIFETIME, DEFAULT_PATH,
            Passkeys.SITE, "", "", 0, FormSettings.siteDefaults(), Map.of(), false, WebAuthnSettings.DEFAULT_RESIDENT_KEY,
            WebAuthnSettings.DEFAULT_CHALLENGE_SKEW, WebAuthnSettings.DEFAULT_SIGNED_AT_SKEW, WebAuthnSettings.DEFAULT_ANONYMOUS_GRACE);
    }

    /**
     * {@code datum.webauthn.path}: one leading slash, no trailing slash.
     *
     * @throws IllegalArgumentException for an empty path
     */
    public static String normalisePath(String path) {
        String clean = path == null ? "" : path.strip();
        while (clean.endsWith("/")) {
            clean = clean.substring(0, clean.length() - 1);
        }
        if (clean.isEmpty()) {
            throw new DatumConfigurationException("datum.webauthn.path", "datum.webauthn.path must not be empty.");
        }
        return clean.startsWith("/") ? clean : "/" + clean;
    }

    /**
     * The ceremony's settings, after the start checks of the relying-party id and the origins (a value the browser
     * would reject fails the start, naming the property). Not set up (no rp-id or origins) is not a failure: a WARN
     * says so, and the endpoints answer 503 {@code signing.not_set_up}.
     *
     * @param applicationName the name the relying party falls back to when {@code rp-name} is empty
     */
    public WebAuthnSettings webAuthnSettings(String applicationName) {
        OriginChecks.validate(rpId, origins);
        String name = rpName.isEmpty() ? (applicationName == null ? "" : applicationName) : rpName;
        WebAuthnSettings settings = new WebAuthnSettings(rpId, name.isEmpty() ? rpId : name, origins, window, anonymous, passkeys == Passkeys.FORM,
            residentKey, challengeSkew, signedAtSkew, anonymousGrace);
        if (!settings.ready()) {
            LOG.warn("Passkeys are not set up: set datum.webauthn.rp-id and datum.webauthn.origins. Until then the passkey endpoints answer "
                + "503 signing.not_set_up, a required form cannot be signed, and datum-webauthn health is DOWN.");
        }
        return settings;
    }

    /**
     * The challenges' HMAC key: the configured secret (at least 32 bytes), or one made now with a WARN that a
     * challenge then verifies only on the instance that issued it.
     *
     * @throws IllegalStateException for a secret shorter than 32 bytes
     */
    public byte[] secretBytes() {
        if (secret.isBlank()) {
            byte[] made = new byte[48];
            new SecureRandom().nextBytes(made);
            LOG.warn("datum.webauthn.secret is not set, so this process made one: a registration challenge can be verified only by the "
                + "instance that issued it, and none survives a restart. Set datum.webauthn.secret (32 bytes or more, the same on every "
                + "instance) from your secret store.");
            return made;
        }
        byte[] bytes = secret.getBytes(StandardCharsets.UTF_8);
        if (bytes.length < 32) {
            throw new DatumConfigurationException("datum.webauthn.secret", "datum.webauthn.secret must be at least 32 bytes (it is " + bytes.length + ").");
        }
        return bytes;
    }

    /**
     * {@code datum.webauthn.challenge-ttl}, checked.
     *
     * @throws IllegalStateException outside 10 seconds to an hour
     */
    public Duration checkedChallengeTtl() {
        if (challengeTtl.compareTo(PasskeyChallenges.MIN_LIFETIME) < 0 || challengeTtl.compareTo(PasskeyChallenges.MAX_LIFETIME) > 0) {
            throw new DatumConfigurationException("datum.webauthn.challenge-ttl", "datum.webauthn.challenge-ttl must be between " + PasskeyChallenges.MIN_LIFETIME.toSeconds()
                + " seconds and " + PasskeyChallenges.MAX_LIFETIME.toMinutes() + " minutes (it is " + challengeTtl + ").");
        }
        return challengeTtl;
    }

    /**
     * The multi-process policy for a store a second instance must share: refused unless
     * {@code datum.webauthn.allow-memory-stores=true} acknowledges single-instance use, then a WARN.
     *
     * @param store       the store, as the message names it ({@code replay guard (datum_passkey_use)})
     * @param consequence what a second instance or a restart would get wrong
     * @throws DatumConfigurationException without the acknowledgement, naming the fix
     */
    public void acknowledgeMemoryStore(String store, String consequence) {
        if (!allowMemoryStores) {
            throw new DatumConfigurationException("datum.webauthn", "datum.webauthn has no SQL store for its " + store + ", and the in-memory one is refused because "
                + consequence + ". Add one DataSource and run "
                + "META-INF/datum/db/migration/<dialect>/V400__datum_webauthn.sql, define your own bean, or set "
                + "datum.webauthn.allow-memory-stores=true to acknowledge a single instance.",
                "Give the application a DataSource (datum.jdbc.initialize-schema makes the tables in an embedded database; "
                    + "V400__datum_webauthn.sql elsewhere), define your own store beans, or set datum.webauthn.allow-memory-stores=true "
                    + "to run a single instance on memory.");
        }
        LOG.warn("datum.webauthn keeps its {} in memory (datum.webauthn.allow-memory-stores=true): {}. Single-instance use only.", store, consequence);
    }
}
