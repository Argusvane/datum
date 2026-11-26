package com.argusvane.datum.webauthn;

import com.argusvane.datum.core.DatumConfigurationException;
import com.argusvane.datum.webauthn.FormSigning;
import com.argusvane.datum.webauthn.FormSigningSource;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Each form's signing settings from {@code datum.webauthn} (the form defaults) and {@code datum.webauthn.forms.<key>}
 * (the overrides). An application that
 * keeps these settings in its own store supplies a {@code FormSigningSource} bean.
 *
 * <p>Properties are typed by hand, and a fallback to the default for an unknown word would weaken signing without a
 * sound: a mistyped
 * {@code mode=requried} reads as {@code off} and the receiver then accepts unsigned submissions. So the words are
 * checked when this source is made and an unknown one stops the start, naming the property. Words are compared
 * without case or surrounding spaces, at the site level as well as per form.
 */
public final class PropertiesFormSigningSource implements FormSigningSource {

    private static final List<String> MODES = List.of("off", "optional", "required");
    private static final List<String> SCOPES = List.of("envelope", "submission", "values");
    private static final List<String> PLACEMENTS = List.of("embedded", "wrapper");
    private static final List<String> VERIFICATIONS = List.of("required", "preferred");
    private static final List<String> UNAVAILABLE = List.of("refuse", "accept");

    private final PasskeySettings settings;

    /**
     * @throws IllegalStateException naming the property when a setting holds a word outside its set
     */
    public PropertiesFormSigningSource(PasskeySettings settings) {
        this.settings = settings;
        validate(settings);
    }

    @Override
    public FormSigning forForm(String formKey) {
        PasskeySettings.FormSettings site = settings.siteSigning();
        PasskeySettings.FormSettings form = formKey == null ? null : settings.forms().get(formKey);
        PasskeySettings.FormSettings set = form == null ? PasskeySettings.FormSettings.none() : form;
        return FormSigning.builder()
            .mode(FormSigning.Mode.of(first(set.mode(), site.mode())))
            .scope(first(set.scope(), site.scope()))
            .placement(first(set.placement(), site.placement()))
            .userVerification(first(set.userVerification(), site.userVerification()))
            .statement(set.statement() != null ? set.statement() : site.statement())
            .verify(set.verify() != null ? set.verify() : Boolean.TRUE.equals(site.verify()))
            .unavailable(first(set.unavailable(), site.unavailable()))
            .build();
    }

    private static String first(String own, String fallback) {
        return word(own != null && !own.isBlank() ? own : fallback);
    }

    private static String word(String value) {
        return value == null ? "" : value.strip().toLowerCase(Locale.ROOT);
    }

    // ------------------------------------------------------------------------------------------------ start checks

    private static void validate(PasskeySettings settings) {
        PasskeySettings.FormSettings site = settings.siteSigning();
        check("datum.webauthn", site.mode(), site.scope(), site.placement(), site.userVerification(), site.unavailable(), true);
        for (Map.Entry<String, PasskeySettings.FormSettings> entry : settings.forms().entrySet()) {
            PasskeySettings.FormSettings form = entry.getValue();
            if (form == null) {
                continue;
            }
            check("datum.webauthn.forms[" + entry.getKey() + "]", form.mode(), form.scope(), form.placement(), form.userVerification(),
                form.unavailable(), false);
        }
    }

    /** A site-level word must name something; a per-form one may be left out (the default applies). */
    private static void check(String prefix, String mode, String scope, String placement, String userVerification, String unavailable,
                              boolean site) {
        one(prefix + ".mode", mode, MODES, site);
        one(prefix + ".scope", scope, SCOPES, site);
        one(prefix + ".placement", placement, PLACEMENTS, site);
        one(prefix + ".user-verification", userVerification, VERIFICATIONS, site);
        one(prefix + ".unavailable", unavailable, UNAVAILABLE, site);
    }

    private static void one(String property, String value, List<String> allowed, boolean required) {
        if (value == null || value.isBlank()) {
            if (!required) {
                return;
            }
        } else if (allowed.contains(word(value))) {
            return;
        }
        throw new DatumConfigurationException(property, property + " is \"" + (value == null ? "" : value) + "\", which is not one of "
            + String.join(", ", allowed) + ". An unknown word is refused at start instead of falling back to a default, because the "
            + "fallback could turn signing off.", "Set " + property + " to one of " + String.join(", ", allowed) + ".");
    }
}
