package com.argusvane.datum.pdf.spring;

import com.argusvane.datum.pdf.web.PdfRoutes;
import com.argusvane.datum.springweb.autoconfigure.DatumOpenApiAutoConfiguration;
import com.argusvane.datum.springweb.spring.DatumOpenApi;
import com.argusvane.datum.springweb.spring.DatumOpenApiSupport;
import io.swagger.v3.oas.models.OpenAPI;
import io.swagger.v3.oas.models.Paths;
import java.util.List;
import org.springdoc.core.models.GroupedOpenApi;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication.Type;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.context.annotation.Bean;

/**
 * The {@code datum-pdf} springdoc group. A separate auto-configuration, ordered before springdoc's own (a group
 * defined after springdoc's {@code MultipleOpenApiSupportConfiguration} is evaluated is silently missing).
 * Switched-off endpoints are excluded from the group, so the document lists exactly the enabled routes.
 */
@AutoConfiguration(after = {DatumOpenApiAutoConfiguration.class, DatumPdfAutoConfiguration.class}, beforeName = {
    DatumOpenApi.SPRINGDOC_CONFIGURATION,
    DatumOpenApi.SPRINGDOC_WEBMVC_MULTIPLE,
    DatumOpenApi.SPRINGDOC_WEBFLUX_MULTIPLE})
@ConditionalOnClass(name = DatumOpenApi.GROUPED_OPEN_API)
@ConditionalOnProperty(prefix = "datum", name = "enabled", matchIfMissing = true)
@ConditionalOnProperty(prefix = "datum.pdf", name = "enabled", matchIfMissing = true)
public final class DatumPdfOpenApiAutoConfiguration {

    /** The base path the WebFlux router operations are annotated with. */
    static final String ANNOTATED_BASE = "/api";

    @Bean
    @ConditionalOnBean({DatumOpenApiSupport.class, PdfRoutes.class})
    @ConditionalOnWebApplication(type = Type.SERVLET)
    GroupedOpenApi datumPdfGroup(DatumOpenApiSupport support, PdfRoutes routes) {
        return support.group("pdf", routes.groupPaths(), routes.disabledPaths());
    }

    /**
     * On WebFlux the operations are annotated at {@code /api}, so the group is cut from that base and a customizer
     * moves the path keys to the configured {@code datum.web.api.path}.
     */
    @Bean
    @ConditionalOnBean({DatumOpenApiSupport.class, PdfRoutes.class})
    @ConditionalOnWebApplication(type = Type.REACTIVE)
    GroupedOpenApi datumPdfReactiveGroup(DatumOpenApiSupport support, PdfRoutes routes) {
        GroupedOpenApi group = support.group("pdf", routes.groupPaths(ANNOTATED_BASE), routes.disabledPaths(ANNOTATED_BASE));
        if (!routes.api().equals(ANNOTATED_BASE)) {
            group.addAllOpenApiCustomizer(List.of(openApi -> rebase(openApi, routes.api())));
        }
        return group;
    }

    static void rebase(OpenAPI openApi, String api) {
        Paths paths = openApi.getPaths();
        if (paths == null) {
            return;
        }
        Paths moved = new Paths();
        paths.forEach((path, item) -> moved.addPathItem(path.startsWith(ANNOTATED_BASE + "/") || path.equals(ANNOTATED_BASE)
            ? api + path.substring(ANNOTATED_BASE.length()) : path, item));
        openApi.setPaths(moved);
    }
}
