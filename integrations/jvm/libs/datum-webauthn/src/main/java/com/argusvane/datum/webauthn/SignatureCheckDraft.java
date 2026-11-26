package com.argusvane.datum.webauthn;

import java.time.Duration;
import java.util.Objects;

/**
 * One submission's passkey signature as a {@link SignatureCheckCustomizer} sees it: the form, who sends it, the
 * registered passkey that signed and the channel, read only, and what a customizer may set for this check: user
 * verification (required, never weaker than the form's) and the signing window (as long as the site's or shorter, never
 * longer). Each value only tightens: it is compared with what the draft holds now, so a later customizer can never undo
 * what an earlier one required (another starter's hook loosening an application's policy).
 *
 * <p>Never the challenge, the stored key or algorithm, the relying party or the origins: those are what the assertion
 * proves.
 */
public final class SignatureCheckDraft {

    private final String formKey;
    private final FormSigning form;
    private final PasskeySubject submitter;
    private final PasskeyRecord passkey;
    private final String channel;
    private boolean userVerification;
    private Duration window;

    SignatureCheckDraft(String formKey, FormSigning form, PasskeySubject submitter, PasskeyRecord passkey, String channel, Duration window) {
        this.formKey = Objects.requireNonNull(formKey, "formKey");
        this.form = Objects.requireNonNull(form, "form");
        this.submitter = Objects.requireNonNull(submitter, "submitter");
        this.passkey = Objects.requireNonNull(passkey, "passkey");
        this.channel = Objects.requireNonNull(channel, "channel");
        this.userVerification = form.requiresUserVerification();
        this.window = Objects.requireNonNull(window, "window");
    }

    /** The form the submission is for (read only). */
    public String formKey() {
        return formKey;
    }

    /** The form's signing settings (read only). */
    public FormSigning form() {
        return form;
    }

    /** Who sends the submission (read only). */
    public PasskeySubject submitter() {
        return submitter;
    }

    /** The registered passkey the signature names: its owner, form, AAGUID, attestation format, flags, label (read only). */
    public PasskeyRecord passkey() {
        return passkey;
    }

    /** How the submission came in: {@code http}, or the caller's channel word (read only). */
    public String channel() {
        return channel;
    }

    /** Whether the assertion must carry user verification (fingerprint, face or PIN). */
    public boolean userVerificationRequired() {
        return userVerification;
    }

    /**
     * Requires user verification for this check; {@code false} leaves it as it is and is refused once it is required
     * (by the form, or by a customizer before this one).
     *
     * @throws IllegalArgumentException for {@code false} where verification is already required
     */
    public void userVerificationRequired(boolean required) {
        if (!required && this.userVerification) {
            throw new IllegalArgumentException("User verification is already required for this signature (by the form or an earlier customizer); it may be made stricter, never weaker.");
        }
        this.userVerification = required;
    }

    /** How far the client's signing time may be from this server's time when the signature arrives. */
    public Duration window() {
        return window;
    }

    /**
     * Sets the signing window for this check: as long as the window now (the site's {@code datum.webauthn.window}, or
     * what a customizer before this one left) or shorter, whole seconds of at least one.
     *
     * @throws IllegalArgumentException for null, a window under one second, or one longer than the window now
     */
    public void window(Duration window) {
        if (window == null || window.getSeconds() < 1 || window.compareTo(this.window) > 0) {
            throw new IllegalArgumentException("The signing window is 1 s to " + this.window + " (the site's, or what an earlier customizer left), not "
                + window + ".");
        }
        this.window = Duration.ofSeconds(window.getSeconds());
    }
}
