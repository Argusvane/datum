package com.argusvane.datum.webauthn.web;

import com.argusvane.datum.webauthn.PasskeySettings;
import java.util.List;

/**
 * Where the passkey endpoints live, from {@code datum.webauthn.path} ({@code /api/webauthn}).
 *
 * <p>One place computes the paths so the MVC mapping, the WebFlux router, the route registry and the OpenAPI
 * group cannot disagree. The MVC controller reads {@link #path()} through a SpEL expression, which is why this is
 * a bean named {@code datumWebAuthnRoutes} (the same device {@code FormsRoutes} uses).
 */
public final class PasskeysRoutes {

    public static final String BEAN_NAME = "datumWebAuthnRoutes";

    private final String path;

    public PasskeysRoutes(PasskeySettings settings) {
        this.path = settings.path();
    }

    /** The base path, no trailing slash. */
    public String path() {
        return path;
    }

    public String challengePath() {
        return path() + "/challenge";
    }

    public String registerPath() {
        return path() + "/register";
    }

    public String listPath() {
        return path() + "/passkeys";
    }

    public String onePath() {
        return path() + "/passkeys/{id}";
    }

    public String checkChallengePath() {
        return path() + "/passkeys/{id}/check-challenge";
    }

    public String checkPath() {
        return path() + "/passkeys/{id}/check";
    }

    /** The paths as WebFlux patterns, for {@code DatumRouteRegistry}. */
    public List<String> routes() {
        return List.of(challengePath(), registerPath(), listPath(), onePath(), checkChallengePath(), checkPath());
    }

    /** The OpenAPI group's patterns. */
    public List<String> groupPaths() {
        return List.of(path(), path() + "/**");
    }
}
