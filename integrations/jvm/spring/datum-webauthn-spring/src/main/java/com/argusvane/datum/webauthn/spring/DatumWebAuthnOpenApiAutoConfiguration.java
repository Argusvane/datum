package com.argusvane.datum.webauthn.spring;

import com.argusvane.datum.springweb.autoconfigure.DatumOpenApiAutoConfiguration;
import com.argusvane.datum.springweb.spring.DatumOpenApi;
import com.argusvane.datum.springweb.spring.DatumOpenApiSupport;
import com.argusvane.datum.webauthn.web.PasskeysRoutes;
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
 * The {@code datum-webauthn} springdoc group. A separate auto-configuration, ordered before springdoc's own:
 * a group defined after springdoc's {@code MultipleOpenApiSupportConfiguration} is evaluated
 * is silently missing. The group exists only when the endpoints are on, because the routes bean does.
 */
@AutoConfiguration(after = {DatumOpenApiAutoConfiguration.class, DatumWebAuthnWebAutoConfiguration.class}, beforeName = {
    DatumOpenApi.SPRINGDOC_CONFIGURATION,
    DatumOpenApi.SPRINGDOC_WEBMVC_MULTIPLE,
    DatumOpenApi.SPRINGDOC_WEBFLUX_MULTIPLE})
@ConditionalOnClass(name = DatumOpenApi.GROUPED_OPEN_API)
@ConditionalOnProperty(prefix = "datum", name = "enabled", matchIfMissing = true)
@ConditionalOnProperty(prefix = "datum.webauthn", name = "enabled", havingValue = "true")
public final class DatumWebAuthnOpenApiAutoConfiguration {

    /** The path the WebFlux router operations are annotated with. */
    static final String ANNOTATED_PATH = "/api/webauthn";

    @Bean
    @ConditionalOnBean({DatumOpenApiSupport.class, PasskeysRoutes.class})
    @ConditionalOnWebApplication(type = Type.SERVLET)
    GroupedOpenApi datumWebAuthnGroup(DatumOpenApiSupport support, PasskeysRoutes routes) {
        return support.group("webauthn", routes.groupPaths(), List.of());
    }

    /**
     * On WebFlux the operations are annotated at {@code /api/webauthn}, so the group is cut from there and a
     * customizer moves the path keys to the configured {@code datum.webauthn.path}.
     */
    @Bean
    @ConditionalOnBean({DatumOpenApiSupport.class, PasskeysRoutes.class})
    @ConditionalOnWebApplication(type = Type.REACTIVE)
    GroupedOpenApi datumWebAuthnReactiveGroup(DatumOpenApiSupport support, PasskeysRoutes routes) {
        GroupedOpenApi group = support.group("webauthn", List.of(ANNOTATED_PATH, ANNOTATED_PATH + "/**"), List.of());
        if (!routes.path().equals(ANNOTATED_PATH)) {
            group.addAllOpenApiCustomizer(List.of(openApi -> rebase(openApi, routes.path())));
        }
        return group;
    }

    static void rebase(OpenAPI openApi, String path) {
        Paths paths = openApi.getPaths();
        if (paths == null) {
            return;
        }
        Paths moved = new Paths();
        paths.forEach((key, item) -> moved.addPathItem(key.equals(ANNOTATED_PATH) || key.startsWith(ANNOTATED_PATH + "/")
            ? path + key.substring(ANNOTATED_PATH.length()) : key, item));
        openApi.setPaths(moved);
    }
}
