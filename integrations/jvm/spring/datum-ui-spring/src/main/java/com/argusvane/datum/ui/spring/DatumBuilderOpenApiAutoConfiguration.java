package com.argusvane.datum.ui.spring;

import com.argusvane.datum.springweb.autoconfigure.DatumOpenApiAutoConfiguration;
import com.argusvane.datum.springweb.spring.DatumOpenApi;
import com.argusvane.datum.springweb.spring.DatumOpenApiSupport;
import com.argusvane.datum.ui.builder.BuilderRoutes;
import io.swagger.v3.oas.models.OpenAPI;
import io.swagger.v3.oas.models.Operation;
import io.swagger.v3.oas.models.PathItem;
import io.swagger.v3.oas.models.Paths;
import java.util.List;
import java.util.Map;
import org.springdoc.core.models.GroupedOpenApi;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBooleanProperty;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication.Type;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.context.annotation.Bean;

/**
 * The {@code datum-ui} springdoc group: the builder's write endpoints, present only with
 * {@code datum.builder.enabled=true}. Ordered before springdoc's own configuration, as every
 * Datum group is.
 *
 * <p>The writes share their paths with the forms module's reads ({@code /forms/{key}/translations} is GET there
 * and PUT here), so the group keeps only the operations tagged {@code datum-ui}; the {@code datum-forms} group,
 * which matches {@code /forms/**}, lists them beside the reads.
 */
@AutoConfiguration(after = {DatumOpenApiAutoConfiguration.class, DatumBuilderAutoConfiguration.class}, beforeName = {
    DatumOpenApi.SPRINGDOC_CONFIGURATION,
    DatumOpenApi.SPRINGDOC_WEBMVC_MULTIPLE,
    DatumOpenApi.SPRINGDOC_WEBFLUX_MULTIPLE})
@ConditionalOnClass(name = DatumOpenApi.GROUPED_OPEN_API)
@ConditionalOnProperty(prefix = "datum", name = "enabled", matchIfMissing = true)
@ConditionalOnBooleanProperty(name = "datum.builder.enabled")
public final class DatumBuilderOpenApiAutoConfiguration {

    /** The tag every builder operation carries. */
    static final String TAG = "datum-ui";

    /** The base path the WebFlux router operations are annotated with. */
    static final String ANNOTATED_BASE = "/api";

    @Bean
    @ConditionalOnBean({DatumOpenApiSupport.class, BuilderRoutes.class})
    @ConditionalOnWebApplication(type = Type.SERVLET)
    GroupedOpenApi datumUiGroup(DatumOpenApiSupport support, BuilderRoutes routes) {
        GroupedOpenApi group = support.group("ui", BuilderRoutes.groupPaths(routes.api()), List.of());
        group.addAllOpenApiCustomizer(List.of(DatumBuilderOpenApiAutoConfiguration::keepBuilderOperations));
        return group;
    }

    /**
     * On WebFlux the operations are annotated at {@code /api}: the group is cut from that base and the keys are
     * moved to the configured {@code datum.web.api.path}, as the forms group does.
     */
    @Bean
    @ConditionalOnBean({DatumOpenApiSupport.class, BuilderRoutes.class})
    @ConditionalOnWebApplication(type = Type.REACTIVE)
    GroupedOpenApi datumUiReactiveGroup(DatumOpenApiSupport support, BuilderRoutes routes) {
        GroupedOpenApi group = support.group("ui", BuilderRoutes.groupPaths(ANNOTATED_BASE), List.of());
        group.addAllOpenApiCustomizer(List.of(DatumBuilderOpenApiAutoConfiguration::keepBuilderOperations));
        if (!routes.api().equals(ANNOTATED_BASE)) {
            group.addAllOpenApiCustomizer(List.of(openApi -> rebase(openApi, routes.api())));
        }
        return group;
    }

    /** Takes out every operation not tagged {@link #TAG}, and a path left with none. */
    static void keepBuilderOperations(OpenAPI openApi) {
        Paths paths = openApi.getPaths();
        if (paths == null) {
            return;
        }
        Paths kept = new Paths();
        paths.forEach((path, item) -> {
            for (Map.Entry<PathItem.HttpMethod, Operation> entry : item.readOperationsMap().entrySet()) {
                List<String> tags = entry.getValue().getTags();
                if (tags == null || !tags.contains(TAG)) {
                    item.operation(entry.getKey(), null);
                }
            }
            if (!item.readOperations().isEmpty()) {
                kept.addPathItem(path, item);
            }
        });
        openApi.setPaths(kept);
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
