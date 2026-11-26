package com.argusvane.datum.webauthn.web;

import com.argusvane.datum.web.monitoring.DatumHealthContributors;
import com.argusvane.datum.webauthn.WebAuthnSettings;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * The {@code datum-webauthn} health check: UP when passkeys are set up (a relying-party id and origins); DOWN
 * names what is missing, because every endpoint answers 503 {@code signing.not_set_up} until it is set. The detail
 * says where each store lives ({@code memory}, {@code jdbc} or {@code custom}), which an operator running more than
 * one instance should read.
 */
public final class WebAuthnHealth {

    /** The name under which the check is registered. */
    public static final String NAME = "datum-webauthn";

    private final WebAuthnSettings settings;
    private final Map<String, Object> details;

    public WebAuthnHealth(WebAuthnSettings settings, String passkeyStore, String useStore, String challengeStore, String passkeys) {
        this.settings = settings;
        Map<String, Object> fixed = new LinkedHashMap<>();
        fixed.put("passkeyStore", passkeyStore);
        fixed.put("replayStore", useStore);
        fixed.put("challengeStore", challengeStore);
        fixed.put("passkeys", passkeys);
        this.details = fixed;
    }

    /** The check's state now. */
    public DatumHealthContributors.Status status() {
        Map<String, Object> shown = new LinkedHashMap<>(details);
        shown.put("rpId", settings.rpId());
        shown.put("anonymous", settings.anonymous());
        if (!settings.ready()) {
            shown.put("reason", settings.rpId().isEmpty()
                ? "Passkeys are not set up: set datum.webauthn.rp-id and datum.webauthn.origins."
                : "Passkeys are not set up: set datum.webauthn.origins.");
            return new DatumHealthContributors.Status(false, shown);
        }
        return DatumHealthContributors.Status.up(shown);
    }
}
