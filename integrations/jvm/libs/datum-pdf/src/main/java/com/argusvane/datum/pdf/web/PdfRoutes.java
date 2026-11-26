package com.argusvane.datum.pdf.web;

import com.argusvane.datum.web.WebSettings;
import java.util.ArrayList;
import java.util.List;

/**
 * Where the PDF endpoints live and which of them are on, from {@code datum.web.api.*}: one place computes the paths
 * so the MVC mapping, the WebFlux router, the route registry and the OpenAPI group cannot disagree (as
 * {@code FormsRoutes} and {@code SubmissionsRoutes} do). The MVC controllers read {@link #api()} through a SpEL
 * expression, which is why this is a bean named {@code datumPdfRoutes}.
 *
 * <p>Switches under {@code datum.web.api.endpoints.*}, all off until the application sets them: {@code pdf} ({@code POST /pdf}),
 * {@code fill} ({@code POST /pdf/fill}), {@code sign} ({@code POST /pdf/sign}), {@code verify}
 * ({@code POST /pdf/verify}) and {@code certificate} ({@code GET /server/certificate}). A switched-off endpoint
 * has no mapping at all, so it answers 404 and the application may map the path itself.
 */
public final class PdfRoutes {

    public static final String BEAN_NAME = "datumPdfRoutes";

    private final WebSettings.Api api;

    public PdfRoutes(WebSettings settings) {
        this.api = settings.api();
    }

    /** The configured API base path ({@code /api}), no trailing slash. */
    public String api() {
        return api.path();
    }

    public boolean pdfEnabled() {
        return api.endpointEnabled("pdf");
    }

    public boolean fillEnabled() {
        return api.endpointEnabled("fill");
    }

    public boolean signEnabled() {
        return api.endpointEnabled("sign");
    }

    public boolean verifyEnabled() {
        return api.endpointEnabled("verify");
    }

    public boolean certificateEnabled() {
        return api.endpointEnabled("certificate");
    }

    public String pdfPath() {
        return api() + "/pdf";
    }

    public String fillPath() {
        return api() + "/pdf/fill";
    }

    public String signPath() {
        return api() + "/pdf/sign";
    }

    public String verifyPath() {
        return api() + "/pdf/verify";
    }

    public String certificatePath() {
        return api() + "/server/certificate";
    }

    /** The patterns the PDF group documents (before the disabled ones are taken out). */
    public List<String> groupPaths() {
        return groupPaths(api());
    }

    /** The patterns of endpoints that are switched off, for the OpenAPI group's exclusions. */
    public List<String> disabledPaths() {
        return disabledPaths(api());
    }

    /**
     * {@link #groupPaths()} under another base: WebFlux router operations are annotated with the default {@code /api}
     * (springdoc does not resolve placeholders there), so the group matches that base and a customizer moves the keys
     * to the configured one.
     */
    public List<String> groupPaths(String base) {
        return List.of(base + "/pdf", base + "/pdf/**", base + "/server/certificate");
    }

    /** {@link #disabledPaths()} under another base. */
    public List<String> disabledPaths(String base) {
        List<String> off = new ArrayList<>();
        if (!pdfEnabled()) {
            off.add(base + "/pdf");
        }
        if (!fillEnabled()) {
            off.add(base + "/pdf/fill");
        }
        if (!signEnabled()) {
            off.add(base + "/pdf/sign");
        }
        if (!verifyEnabled()) {
            off.add(base + "/pdf/verify");
        }
        if (!certificateEnabled()) {
            off.add(base + "/server/certificate");
        }
        return off;
    }

    /** The enabled routes as WebFlux path patterns, for {@code DatumRouteRegistry}. */
    public List<String> enabledRoutes() {
        List<String> on = new ArrayList<>();
        if (pdfEnabled()) {
            on.add(pdfPath());
        }
        if (fillEnabled()) {
            on.add(fillPath());
        }
        if (signEnabled()) {
            on.add(signPath());
        }
        if (verifyEnabled()) {
            on.add(verifyPath());
        }
        if (certificateEnabled()) {
            on.add(certificatePath());
        }
        return on;
    }
}
