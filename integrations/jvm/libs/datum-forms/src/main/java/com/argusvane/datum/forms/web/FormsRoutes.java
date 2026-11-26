package com.argusvane.datum.forms.web;

import com.argusvane.datum.web.WebSettings;
import java.util.ArrayList;
import java.util.List;

/**
 * Where the forms read endpoints live and which of them are on, from {@code datum.web.api.*}.
 *
 * <p>One place computes the paths so the MVC mapping, the WebFlux router, the WebFlux route patterns and the OpenAPI
 * group cannot disagree: the document lists exactly the enabled routes. The MVC controllers
 * read {@link #api()} through a SpEL expression, which is why this is a bean named {@code datumFormsRoutes}.
 * Endpoint names: {@code definition} switches the definition and translations reads,
 * {@code data-sources} the options read. There is no list route: which forms exist is the
 * application's own query.
 */
public final class FormsRoutes {

    public static final String BEAN_NAME = "datumFormsRoutes";

    private final WebSettings.Api api;

    public FormsRoutes(WebSettings settings) {
        this.api = settings.api();
    }

    /** The configured API base path ({@code /api}), no trailing slash. */
    public String api() {
        return api.path();
    }

    public boolean definitionEnabled() {
        return api.endpointEnabled("definition");
    }

    public boolean dataSourcesEnabled() {
        return api.endpointEnabled("data-sources");
    }

    public String definitionPath() {
        return api() + "/forms/{key}/definition";
    }

    public String translationsPath() {
        return api() + "/forms/{key}/translations";
    }

    public String dataSourcePath() {
        return api() + "/data-sources/{id}";
    }

    /** The patterns the forms group documents (before the disabled ones are taken out). */
    public List<String> groupPaths() {
        return groupPaths(api());
    }

    /** The patterns of endpoints that are switched off, for the OpenAPI group's exclusions. */
    public List<String> disabledPaths() {
        return disabledPaths(api());
    }

    /**
     * {@link #groupPaths()} under another base. WebFlux router operations are annotated with the default
     * {@code /api} (springdoc does not resolve placeholders there), so the group matches that base and a
     * customizer moves the keys to the configured one.
     */
    public List<String> groupPaths(String base) {
        return List.of(base + "/forms/**", base + "/data-sources/**");
    }

    /** {@link #disabledPaths()} under another base. */
    public List<String> disabledPaths(String base) {
        List<String> off = new ArrayList<>();
        if (!definitionEnabled()) {
            off.add(base + "/forms/*/definition");
            off.add(base + "/forms/*/translations");
        }
        if (!dataSourcesEnabled()) {
            off.add(base + "/data-sources/*");
        }
        return off;
    }

    /** The enabled routes as WebFlux path patterns, for {@code DatumRouteRegistry}. */
    public List<String> enabledRoutes() {
        List<String> on = new ArrayList<>();
        if (definitionEnabled()) {
            on.add(definitionPath());
            on.add(translationsPath());
        }
        if (dataSourcesEnabled()) {
            on.add(dataSourcePath());
        }
        return on;
    }
}
