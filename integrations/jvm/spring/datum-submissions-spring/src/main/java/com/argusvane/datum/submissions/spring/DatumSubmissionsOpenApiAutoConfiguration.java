package com.argusvane.datum.submissions.spring;

import com.argusvane.datum.springweb.autoconfigure.DatumOpenApiAutoConfiguration;
import com.argusvane.datum.springweb.spring.DatumOpenApi;
import com.argusvane.datum.springweb.spring.DatumOpenApiSupport;
import com.argusvane.datum.submissions.web.SubmissionsRoutes;
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
 * The {@code datum-submissions} springdoc group. A separate auto-configuration, ordered before springdoc's own:
 * a group defined after springdoc's {@code MultipleOpenApiSupportConfiguration} is
 * evaluated is silently missing. Switched-off endpoints are excluded from the group, so the document lists
 * exactly the enabled routes.
 */
@AutoConfiguration(after = {DatumOpenApiAutoConfiguration.class, DatumSubmissionsAutoConfiguration.class}, beforeName = {
    DatumOpenApi.SPRINGDOC_CONFIGURATION,
    DatumOpenApi.SPRINGDOC_WEBMVC_MULTIPLE,
    DatumOpenApi.SPRINGDOC_WEBFLUX_MULTIPLE})
@ConditionalOnClass(name = DatumOpenApi.GROUPED_OPEN_API)
@ConditionalOnProperty(prefix = "datum", name = "enabled", matchIfMissing = true)
public final class DatumSubmissionsOpenApiAutoConfiguration {

    /** The base path the WebFlux router operations are annotated with. */
    static final String ANNOTATED_BASE = "/api";

    @Bean
    @ConditionalOnBean({DatumOpenApiSupport.class, SubmissionsRoutes.class})
    @ConditionalOnWebApplication(type = Type.SERVLET)
    GroupedOpenApi datumSubmissionsGroup(DatumOpenApiSupport support, SubmissionsRoutes routes) {
        return support.group("submissions", routes.groupPaths(), routes.disabledPaths());
    }

    /**
     * On WebFlux the operations are annotated at {@code /api}, so the group is cut from that base and a
     * customizer moves the path keys to the configured {@code datum.web.api.path} (as datum-forms does).
     */
    @Bean
    @ConditionalOnBean({DatumOpenApiSupport.class, SubmissionsRoutes.class})
    @ConditionalOnWebApplication(type = Type.REACTIVE)
    GroupedOpenApi datumSubmissionsReactiveGroup(DatumOpenApiSupport support, SubmissionsRoutes routes) {
        GroupedOpenApi group = support.group("submissions", routes.groupPaths(ANNOTATED_BASE), routes.disabledPaths(ANNOTATED_BASE));
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
