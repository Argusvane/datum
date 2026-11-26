package com.argusvane.datum.ui.builder;

import com.argusvane.datum.web.WebSettings;
import java.util.List;

/**
 * Where the builder's write endpoints live, under {@code datum.web.api.path}: {@code POST /forms},
 * {@code PUT /forms/{key}} and {@code PUT /forms/{key}/translations}, the same paths the forms module reads on.
 * One place computes them so the MVC mapping, the WebFlux router, the route registry and
 * the OpenAPI group cannot disagree. A bean named {@value #BEAN_NAME}, because the MVC controller reads
 * {@link #api()} through SpEL as the forms controllers read theirs.
 */
public final class BuilderRoutes {

    public static final String BEAN_NAME = "datumBuilderRoutes";

    private final String api;

    public BuilderRoutes(WebSettings settings) {
        this.api = settings.api().path();
    }

    /** The API base path ({@code /api}), no trailing slash. */
    public String api() {
        return api;
    }

    public String createPath() {
        return api + "/forms";
    }

    public String formPath() {
        return api + "/forms/{key}";
    }

    public String translationsPath() {
        return api + "/forms/{key}/translations";
    }

    /** The routes, as WebFlux path patterns for {@code DatumRouteRegistry}. */
    public List<String> routes() {
        return List.of(createPath(), formPath(), translationsPath());
    }

    /** The patterns the {@code datum-ui} group documents, under a base. */
    public static List<String> groupPaths(String base) {
        return List.of(base + "/forms", base + "/forms/*", base + "/forms/*/translations");
    }
}
