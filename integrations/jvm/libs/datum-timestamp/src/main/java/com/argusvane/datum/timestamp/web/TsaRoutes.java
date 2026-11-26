package com.argusvane.datum.timestamp.web;

import java.util.List;

/**
 * Where the timestamp endpoints live, from {@code datum.tsa.path}.
 *
 * <p>One place computes the paths so the MVC mapping, the WebFlux router, the route registry and the OpenAPI
 * group cannot disagree. The MVC controller reads {@link #path()} through a SpEL expression, which is why this is
 * a bean named {@code datumTsaRoutes} (the same device {@code FormsRoutes} uses).
 */
public final class TsaRoutes {

    public static final String BEAN_NAME = "datumTsaRoutes";

    private final String path;

    public TsaRoutes(TsaSettings settings) {
        this.path = settings.path();
    }

    /** The server's own path (POST), {@code /tsa} unless configured. */
    public String path() {
        return path;
    }

    /** GET: the certificate tokens are signed with now. */
    public String certificatePath() {
        return path() + "/certificate";
    }

    /** GET: every certificate the server has signed with. */
    public String certificatesPath() {
        return path() + "/certificates";
    }

    /** The paths as WebFlux patterns, for {@code DatumRouteRegistry}. */
    public List<String> routes() {
        return List.of(path(), certificatePath(), certificatesPath());
    }

    /** The OpenAPI group's patterns. */
    public List<String> groupPaths() {
        return List.of(path(), path() + "/**");
    }
}
