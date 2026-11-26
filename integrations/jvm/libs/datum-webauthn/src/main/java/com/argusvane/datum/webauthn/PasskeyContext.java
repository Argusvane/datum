package com.argusvane.datum.webauthn;

import java.util.List;

/**
 * What a passkey is being made for: at a form (whoever may submit, amend or
 * test it), or ahead of time on a signed-in person's account. Its purpose and subject are bound into the
 * registration challenge, so a challenge for one context registers nothing in another. (Invitations are not a context
 * yet.)
 *
 * @param purpose what the challenge is for: "register" (a form's submit), "register:amend", "register:test",
 *     "account"
 * @param subject what it is made through: the form's key, or "user:" and the account
 * @param owner who will own it: the account, "" for none (a visitor's)
 * @param origin how it is made: form or account
 * @param userVerification required or preferred
 * @param restrictTo the form it will sign alone ("" for any)
 * @param madeOn the form it is made through ("" ahead of time)
 * @param defaultLabel its name when none is given
 * @param context the form context: submit, amend or test ("" ahead of time)
 */
public record PasskeyContext(String purpose, String subject, String owner, String origin, String userVerification, String restrictTo,
                             String madeOn, String defaultLabel, String context) {

    /** How a passkey can be made. */
    public static final List<String> ORIGINS = List.of("form", "account", "invitation");

    /** The form contexts a passkey can be made in. */
    public static final List<String> FORM_CONTEXTS = List.of("submit", "amend", "test");

    public PasskeyContext {
        owner = owner == null ? "" : owner;
        restrictTo = restrictTo == null ? "" : restrictTo;
        madeOn = madeOn == null ? "" : madeOn;
        defaultLabel = defaultLabel == null ? "" : defaultLabel;
        context = context == null ? "" : context;
    }

    /**
     * A passkey made at a form.
     *
     * @param formKey the form
     * @param account who registers it (its owner; anonymous for none)
     * @param context submit, amend or test (anything else reads as submit)
     * @param perForm whether it will sign this form alone
     * @param form the form's signing settings (its user verification)
     * @param defaultLabel its name when none is given
     */
    public static PasskeyContext forForm(String formKey, PasskeySubject account, String context, boolean perForm, FormSigning form,
                                         String defaultLabel) {
        String chosen = FORM_CONTEXTS.contains(context) ? context : "submit";
        return new PasskeyContext(chosen.equals("submit") ? "register" : "register:" + chosen, formKey, account.uid(), "form",
            form.userVerification(), perForm ? formKey : "", formKey, defaultLabel, chosen);
    }

    /** A passkey a signed-in person adds ahead of time, for any form. */
    public static PasskeyContext forAccount(PasskeySubject account, String defaultLabel) {
        return new PasskeyContext("account", "user:" + account.uid(), account.uid(), "account", "preferred", "", "", defaultLabel, "");
    }
}
