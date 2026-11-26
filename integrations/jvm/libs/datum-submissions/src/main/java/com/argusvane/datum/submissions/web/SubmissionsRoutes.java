package com.argusvane.datum.submissions.web;

import com.argusvane.datum.web.WebSettings;
import java.util.ArrayList;
import java.util.List;

/**
 * Where the submissions endpoints live and which of them are on, from {@code datum.web.api.*}.
 *
 * <p>One place computes the paths so the MVC mapping, the WebFlux router, the route registry and the OpenAPI
 * group cannot disagree (the document lists exactly the enabled routes), as
 * {@code FormsRoutes} does for datum-forms. The MVC controllers read {@link #api()} through a SpEL expression,
 * which is why this is a bean named {@code datumSubmissionsRoutes}. Switches: {@code submissions},
 * {@code validate}, {@code test} and {@code inspect}, every one off until the application sets it ({@code WebSettings.Api#endpointEnabled}).
 */
public final class SubmissionsRoutes {

    public static final String BEAN_NAME = "datumSubmissionsRoutes";

    private final WebSettings.Api api;

    public SubmissionsRoutes(WebSettings settings) {
        this.api = settings.api();
    }

    /** The configured API base path ({@code /api}), no trailing slash. */
    public String api() {
        return api.path();
    }

    public boolean submitEnabled() {
        return api.endpointEnabled("submissions");
    }

    public boolean validateEnabled() {
        return api.endpointEnabled("validate");
    }

    public boolean testEnabled() {
        return api.endpointEnabled("test");
    }

    public boolean inspectEnabled() {
        return api.endpointEnabled("inspect");
    }

    public String submitPath() {
        return api() + "/submissions";
    }

    public String validatePath() {
        return api() + "/submissions/validate";
    }

    public String testPath() {
        return api() + "/submissions/test";
    }

    public String inspectPath() {
        return api() + "/inspect";
    }

    /** The patterns the submissions group documents (before the disabled ones are taken out). */
    public List<String> groupPaths() {
        return groupPaths(api());
    }

    /** The patterns of endpoints that are switched off, for the OpenAPI group's exclusions. */
    public List<String> disabledPaths() {
        return disabledPaths(api());
    }

    /**
     * {@link #groupPaths()} under another base: WebFlux router operations are annotated with the default
     * {@code /api} (springdoc does not resolve placeholders there), so the group matches that base and a
     * customizer moves the keys to the configured one, as datum-forms does.
     */
    public List<String> groupPaths(String base) {
        return List.of(base + "/submissions", base + "/submissions/**", base + "/inspect");
    }

    /** {@link #disabledPaths()} under another base. */
    public List<String> disabledPaths(String base) {
        List<String> off = new ArrayList<>();
        if (!submitEnabled()) {
            off.add(base + "/submissions");
        }
        if (!validateEnabled()) {
            off.add(base + "/submissions/validate");
        }
        if (!testEnabled()) {
            off.add(base + "/submissions/test");
        }
        if (!inspectEnabled()) {
            off.add(base + "/inspect");
        }
        return off;
    }

    /** The enabled routes as WebFlux path patterns, for {@code DatumRouteRegistry}. */
    public List<String> enabledRoutes() {
        List<String> on = new ArrayList<>();
        if (submitEnabled()) {
            on.add(submitPath());
        }
        if (validateEnabled()) {
            on.add(validatePath());
        }
        if (testEnabled()) {
            on.add(testPath());
        }
        if (inspectEnabled()) {
            on.add(inspectPath());
        }
        return on;
    }
}
