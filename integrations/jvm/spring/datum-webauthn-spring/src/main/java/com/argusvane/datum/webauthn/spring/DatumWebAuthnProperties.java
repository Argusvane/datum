package com.argusvane.datum.webauthn.spring;

import com.argusvane.datum.webauthn.PasskeySettings.Passkeys;
import com.argusvane.datum.webauthn.PasskeySettings;
import com.argusvane.datum.webauthn.WebAuthnSettings;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * {@code datum.webauthn.*}: passkey registration and passkey-signed submissions (the site's signing settings
 * and each form's). Off by default: a host
 * that does not set {@code enabled=true} has no passkey endpoints at all (404) and none of this module's beans.
 *
 * <p>Nothing is derived from the request's Host header: the relying-party id and the origins a client may write
 * are configured, or passkeys are not set up (the endpoints answer 503 {@code signing.not_set_up}, health is
 * DOWN). The form defaults ({@code mode}, {@code scope}, {@code placement}, {@code statement}, {@code verify},
 * {@code user-verification}, {@code unavailable}) apply to every form; {@code forms.<key>} overrides them per
 * form. An application that keeps signing settings elsewhere supplies its own {@code FormSigningSource} bean.
 *
 * <p>Unknown members are refused ({@code ignoreUnknownFields = false}) and so is a word outside a setting's set
 * ({@link PropertiesFormSigningSource}): a form key with a dot must be written {@code forms[my.form].mode}, because
 * {@code forms.my.form.mode} would be read as a form {@code my} with a member {@code form}, and a form that was
 * meant to require a signature would silently sign nothing.
 *
 * <p>The Spring binding of {@link PasskeySettings}: {@link #toSettings()} is what the library reads,
 * and {@code passkeys} binds the library's enum.
 */
@ConfigurationProperties(prefix = "datum.webauthn", ignoreUnknownFields = false)
public class DatumWebAuthnProperties {

    /** Turn passkeys on. */
    private boolean enabled = false;

    /** The relying-party id: the registrable domain passkeys are bound to ({@code example.org}); empty means not set up. */
    private String rpId = "";

    /** The name the browser shows for the site; empty means the rp-id. */
    private String rpName = "";

    /** The origins a client may write, exactly: scheme, host and port, no path ({@code https://forms.example.org}). */
    private List<String> origins = new ArrayList<>();

    /** Let visitors who are not signed in make passkeys and sign. */
    private boolean anonymous = false;

    /** Let people register a passkey when they submit a form (the Test context still may). */
    private boolean registerAtSubmit = true;

    /** How long a signature may take to arrive (whole seconds, at least one). */
    private Duration window = Duration.ofSeconds(600);

    /**
     * How long a registration challenge holds: 10 seconds to an hour (the start fails outside that), 300 s by default
     * (five minutes by default). It bounds the page's whole ceremony, from the challenge to the register call.
     */
    private Duration challengeTtl = Duration.ofSeconds(300);

    /** The base path of the endpoints; {@code /challenge}, {@code /register} and {@code /passkeys} hang below it. */
    private String path = "/api/webauthn";

    /** Passkeys sign for every form (site) or only the one they were made on (form). */
    private Passkeys passkeys = Passkeys.SITE;

    /** The HMAC key of registration challenges: at least 32 bytes, the same on every instance. Empty: one is made at start. */
    private String secret = "";

    /** The answer (value path) that names a visitor's passkey, told to the page. */
    private String labelPath = "";

    /**
     * The roles that may make a passkey in a form's Test context, read from the Spring
     * Security authentication ({@code FORM_ADMIN} matches {@code ROLE_FORM_ADMIN}). Empty, the default: nobody may.
     * Who may reach the passkey routes at all is the application's security (DatumRequestMatchers.passkeys()).
     */
    private List<String> testRoles = new ArrayList<>();

    /** Years signed submissions are kept at least, whatever retention says (0: retention decides). For the application's retention job. */
    private int keepYears = 0;

    /** The form default: whether a form's submissions are signed with a passkey: off, optional or required. */
    private String mode = "off";

    /** The form default: what a signature covers: envelope, submission or values. */
    private String scope = "envelope";

    /** The form default: where signatures land: embedded or wrapper (what the page is told; the verifier reads both). */
    private String placement = "embedded";

    /** The form default: the user verification a signature asks for: required or preferred. */
    private String userVerification = "preferred";

    /** The form default: the statement the signer sees and signs; empty for none. */
    private String statement = "";

    /** The form default: whether a signature that cannot be verified refuses the submission (an invalid one always does). */
    private boolean verify = true;

    /** The form default: refuse or accept a required form's submission from a browser without passkeys. */
    private String unavailable = "refuse";

    /** Per-form overrides of the defaults above, by form key. */
    private Map<String, FormSettings> forms = new LinkedHashMap<>();

    /**
     * Acknowledge single-instance use: the passkey, replay-guard and challenge stores may live in this process's
     * memory. Without it the application refuses to start unless a SQL store is configured (a replay guard in
     * memory is one per process: a second instance accepts the same signed document again).
     */
    private boolean allowMemoryStores = false;

    /**
     * The residentKey requirement a registration asks the authenticator for: required (the default: a passkey the browser can
     * offer without being told which), preferred or discouraged. Anything else stops the start.
     */
    private String residentKey = WebAuthnSettings.DEFAULT_RESIDENT_KEY;

    /**
     * How far ahead of this server's clock a registration challenge's issue time may be, for a challenge made on another
     * server whose clock runs ahead. From 0 to 5 minutes.
     */
    private Duration challengeSkew = WebAuthnSettings.DEFAULT_CHALLENGE_SKEW;

    /** How far apart the two signing times a signature carries (the result's and the assertion's) may be. From 0 to 10 minutes. */
    private Duration signedAtSkew = WebAuthnSettings.DEFAULT_SIGNED_AT_SKEW;

    /** How long an anonymous passkey that signed nothing is kept before the purge removes it. From 1 hour to 30 days. */
    private Duration anonymousGrace = WebAuthnSettings.DEFAULT_ANONYMOUS_GRACE;

    /** One form's overrides: a field left unset keeps the default. */
    public static class FormSettings {

        /** This form's signing mode: off, optional or required; unset keeps the default. */
        private String mode;

        /** What a signature covers: envelope, submission or values; unset keeps the default. */
        private String scope;

        /** Where signatures land: embedded or wrapper; unset keeps the default. */
        private String placement;

        /** The user verification a signature asks for: required or preferred; unset keeps the default. */
        private String userVerification;

        /** The statement the signer sees and signs; unset keeps the default. */
        private String statement;

        /** Whether a signature that cannot be verified refuses the submission; unset keeps the default. */
        private Boolean verify;

        /** Refuse or accept a required form's submission from a browser without passkeys; unset keeps the default. */
        private String unavailable;

        public String getMode() {
            return mode;
        }

        public void setMode(String mode) {
            this.mode = mode;
        }

        public String getScope() {
            return scope;
        }

        public void setScope(String scope) {
            this.scope = scope;
        }

        public String getPlacement() {
            return placement;
        }

        public void setPlacement(String placement) {
            this.placement = placement;
        }

        public String getUserVerification() {
            return userVerification;
        }

        public void setUserVerification(String userVerification) {
            this.userVerification = userVerification;
        }

        public String getStatement() {
            return statement;
        }

        public void setStatement(String statement) {
            this.statement = statement;
        }

        public Boolean getVerify() {
            return verify;
        }

        public void setVerify(Boolean verify) {
            this.verify = verify;
        }

        public String getUnavailable() {
            return unavailable;
        }

        public void setUnavailable(String unavailable) {
            this.unavailable = unavailable;
        }
    }

    /** These properties as the library's settings. */
    public PasskeySettings toSettings() {
        Map<String, PasskeySettings.FormSettings> perForm = new LinkedHashMap<>();
        forms.forEach((key, form) -> perForm.put(key, form == null ? null : new PasskeySettings.FormSettings(form.getMode(), form.getScope(),
            form.getPlacement(), form.getUserVerification(), form.getStatement(), form.getVerify(), form.getUnavailable())));
        return new PasskeySettings(enabled, rpId, rpName, origins, anonymous, registerAtSubmit, window, challengeTtl, path, passkeys, secret,
            labelPath, keepYears, new PasskeySettings.FormSettings(mode, scope, placement, userVerification, statement, verify, unavailable),
            perForm, allowMemoryStores, residentKey, challengeSkew, signedAtSkew, anonymousGrace);
    }

    public String getResidentKey() {
        return residentKey;
    }

    public void setResidentKey(String residentKey) {
        this.residentKey = residentKey;
    }

    public Duration getChallengeSkew() {
        return challengeSkew;
    }

    public void setChallengeSkew(Duration challengeSkew) {
        this.challengeSkew = challengeSkew;
    }

    public Duration getSignedAtSkew() {
        return signedAtSkew;
    }

    public void setSignedAtSkew(Duration signedAtSkew) {
        this.signedAtSkew = signedAtSkew;
    }

    public Duration getAnonymousGrace() {
        return anonymousGrace;
    }

    public void setAnonymousGrace(Duration anonymousGrace) {
        this.anonymousGrace = anonymousGrace;
    }

    public boolean isEnabled() {
        return enabled;
    }

    public void setEnabled(boolean enabled) {
        this.enabled = enabled;
    }

    public String getRpId() {
        return rpId;
    }

    public void setRpId(String rpId) {
        this.rpId = rpId == null ? "" : rpId.strip();
    }

    public String getRpName() {
        return rpName;
    }

    public void setRpName(String rpName) {
        this.rpName = rpName == null ? "" : rpName.strip();
    }

    public List<String> getOrigins() {
        return origins;
    }

    public void setOrigins(List<String> origins) {
        this.origins = origins == null ? new ArrayList<>() : new ArrayList<>(origins);
    }

    public boolean isAnonymous() {
        return anonymous;
    }

    public void setAnonymous(boolean anonymous) {
        this.anonymous = anonymous;
    }

    public boolean isRegisterAtSubmit() {
        return registerAtSubmit;
    }

    public void setRegisterAtSubmit(boolean registerAtSubmit) {
        this.registerAtSubmit = registerAtSubmit;
    }

    public Duration getWindow() {
        return window;
    }

    public void setWindow(Duration window) {
        this.window = window;
    }

    public Duration getChallengeTtl() {
        return challengeTtl;
    }

    public void setChallengeTtl(Duration challengeTtl) {
        this.challengeTtl = challengeTtl;
    }

    public String getPath() {
        return path;
    }

    public void setPath(String path) {
        this.path = PasskeySettings.normalisePath(path);
    }

    public Passkeys getPasskeys() {
        return passkeys;
    }

    public void setPasskeys(Passkeys passkeys) {
        this.passkeys = passkeys == null ? Passkeys.SITE : passkeys;
    }

    public String getSecret() {
        return secret;
    }

    public void setSecret(String secret) {
        this.secret = secret == null ? "" : secret;
    }

    public String getLabelPath() {
        return labelPath;
    }

    public void setLabelPath(String labelPath) {
        this.labelPath = labelPath == null ? "" : labelPath.strip();
    }

    public List<String> getTestRoles() {
        return testRoles;
    }

    public void setTestRoles(List<String> testRoles) {
        this.testRoles = testRoles == null ? new ArrayList<>() : new ArrayList<>(testRoles);
    }

    public int getKeepYears() {
        return keepYears;
    }

    public void setKeepYears(int keepYears) {
        this.keepYears = keepYears;
    }

    public String getMode() {
        return mode;
    }

    public void setMode(String mode) {
        this.mode = mode;
    }

    public String getScope() {
        return scope;
    }

    public void setScope(String scope) {
        this.scope = scope;
    }

    public String getPlacement() {
        return placement;
    }

    public void setPlacement(String placement) {
        this.placement = placement;
    }

    public String getUserVerification() {
        return userVerification;
    }

    public void setUserVerification(String userVerification) {
        this.userVerification = userVerification;
    }

    public String getStatement() {
        return statement;
    }

    public void setStatement(String statement) {
        this.statement = statement;
    }

    public boolean isVerify() {
        return verify;
    }

    public void setVerify(boolean verify) {
        this.verify = verify;
    }

    public String getUnavailable() {
        return unavailable;
    }

    public void setUnavailable(String unavailable) {
        this.unavailable = unavailable;
    }

    public Map<String, FormSettings> getForms() {
        return forms;
    }

    public void setForms(Map<String, FormSettings> forms) {
        this.forms = forms == null ? new LinkedHashMap<>() : new LinkedHashMap<>(forms);
    }

    public boolean isAllowMemoryStores() {
        return allowMemoryStores;
    }

    public void setAllowMemoryStores(boolean allowMemoryStores) {
        this.allowMemoryStores = allowMemoryStores;
    }
}
