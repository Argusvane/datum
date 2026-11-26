package com.argusvane.datum.webauthn;

import java.util.List;
import java.util.Objects;
import org.jspecify.annotations.Nullable;

/**
 * One passkey registration as a {@link RegistrationCustomizer} sees it: what it is for and who asks, read only,
 * and what a customizer may set for this request within the site's policy: the label, the user verification and (for the
 * challenge) the resident-key requirement, each only as strict as the policy or stricter. Each value only tightens: it is
 * compared with what the draft holds now, so a later customizer can never undo what an earlier one required (another
 * starter's hook loosening an application's policy; the same rule as {@link SignatureCheckDraft}).
 *
 * <p>Never the challenge, the user handle, the relying party, the origins or the algorithms: those are what the ceremony
 * proves.
 */
public final class RegistrationDraft {

    /** Which of the two calls this is. */
    public enum Step {
        /** The challenge, before it is issued: the options the browser creates the passkey with. */
        CHALLENGE,
        /** The registration, before the challenge is claimed: the posted passkey, before it is verified and stored. */
        REGISTER
    }

    /** From the weakest to the strictest. */
    private static final List<String> USER_VERIFICATION = List.of("preferred", "required");
    private static final List<String> RESIDENT_KEY = List.of("discouraged", "preferred", "required");

    private final Step step;
    private final PasskeyContext context;
    private final PasskeySubject asking;
    private @Nullable String label;
    private String userVerification;
    private String residentKey;

    RegistrationDraft(Step step, PasskeyContext context, PasskeySubject asking, @Nullable String label, String residentKey) {
        this.step = Objects.requireNonNull(step, "step");
        this.context = Objects.requireNonNull(context, "context");
        this.asking = Objects.requireNonNull(asking, "asking");
        this.label = label;
        // The form's word as it is (the options carry it unchanged while no customizer sets one); any word but required is
        // the weakest for the "stricter only" rule (see strictness below).
        this.userVerification = context.userVerification();
        this.residentKey = residentKey;
    }

    /** Which call this is (read only). */
    public Step step() {
        return step;
    }

    /** What the passkey is made for: its purpose, subject, owner, form and the form's policy (read only). */
    public PasskeyContext context() {
        return context;
    }

    /** Who makes it (read only). */
    public PasskeySubject asking() {
        return asking;
    }

    /** The name it will carry as asked for, or null for the default (the context's, or the person's name in the options). */
    public @Nullable String label() {
        return label;
    }

    /**
     * Sets the name it will carry (null for the default). It is cleaned as any label is (control characters folded, cut to
     * the label's length), so a customizer can shorten or replace a label, not smuggle one past the rules.
     */
    public void label(@Nullable String label) {
        this.label = label;
    }

    /** {@code required} or {@code preferred}: whether the authenticator must check the person (fingerprint, face, PIN). */
    public String userVerification() {
        return userVerification;
    }

    /**
     * Sets the user verification for this request: what the draft holds now (the form's policy, or what a customizer before
     * this one left) or stricter. A customizer that sets {@code required} must do so for both steps of a registration, since
     * the registration step is what checks it.
     *
     * @throws IllegalArgumentException for a word other than required or preferred, or one weaker than the value now
     */
    public void userVerification(String word) {
        // The form's own word may be one outside the list (it is carried as it is); it then ranks as preferred, the weakest.
        String now = "required".equals(userVerification) ? "required" : "preferred";
        this.userVerification = atLeast(word, now, USER_VERIFICATION, "user verification");
    }

    /** {@code required}, {@code preferred} or {@code discouraged}: whether the browser should make a discoverable passkey. */
    public String residentKey() {
        return residentKey;
    }

    /**
     * Sets the resident-key requirement the challenge asks for: what the draft holds now (the site's
     * {@code datum.webauthn.resident-key}, or what a customizer before this one left) or stricter. Read at the challenge
     * only (the registration proves nothing about it).
     *
     * @throws IllegalArgumentException for another word, or one weaker than the value now
     */
    public void residentKey(String word) {
        this.residentKey = atLeast(word, residentKey, RESIDENT_KEY, "resident key");
    }

    private static String atLeast(String word, String now, List<String> order, String what) {
        int asked = order.indexOf(word);
        if (asked < 0) {
            throw new IllegalArgumentException("The " + what + " is one of " + order + ", not \"" + word + "\".");
        }
        if (asked < order.indexOf(now)) {
            throw new IllegalArgumentException("The " + what + " may be made stricter than it is now (" + now
                + ", the policy's or an earlier customizer's), never weaker.");
        }
        return word;
    }
}
