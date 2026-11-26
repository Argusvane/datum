package com.argusvane.datum.springweb.spring;

import com.argusvane.datum.web.WebSettings;
import com.argusvane.datum.web.openapi.DatumOpenApiRegistry;
import java.util.List;
import org.springdoc.core.customizers.OpenApiCustomizer;
import org.springdoc.core.models.GroupedOpenApi;

/**
 * Builds a capability's springdoc group with Datum's shared pieces attached.
 *
 * <p>Available as a bean only when springdoc is on the classpath and {@code datum.web.openapi.enabled} is
 * true. A capability's auto-configuration (ordered as {@link DatumOpenApi} describes) calls
 * {@link #group(String, List, List)} from a {@code @Bean} method returning the {@link GroupedOpenApi}.
 */
public final class DatumOpenApiSupport {

    private final WebSettings settings;
    private final DatumOpenApiRegistry registry;
    private final OpenApiCustomizer shared;

    public DatumOpenApiSupport(WebSettings settings, DatumOpenApiRegistry registry) {
        this.settings = settings;
        this.registry = registry;
        this.shared = new DatumOpenApiCustomizer(settings.api().problemDetails());
    }

    /**
     * One group, named {@code datum.web.openapi.group-prefix + capability}.
     *
     * @param capability    {@code forms}, {@code submissions}, {@code ui}, {@code pdf}, {@code tsa}, {@code webauthn}
     * @param pathsToMatch  the group's path patterns (with the configured api, assets, tsa or webauthn path)
     * @param disabledPaths the patterns of endpoints that are switched off: hidden from the document
     */
    public GroupedOpenApi group(String capability, List<String> pathsToMatch, List<String> disabledPaths) {
        String name = settings.openapi().groupPrefix() + capability;
        registry.register(new DatumOpenApiRegistry.Group(name, pathsToMatch, disabledPaths));
        GroupedOpenApi.Builder builder = GroupedOpenApi.builder()
            .group(name)
            .pathsToMatch(pathsToMatch.toArray(String[]::new))
            .addOpenApiCustomizer(shared);
        if (!disabledPaths.isEmpty()) {
            builder.pathsToExclude(disabledPaths.toArray(String[]::new));
        }
        return builder.build();
    }
}
