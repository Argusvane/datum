package com.argusvane.datum.web.openapi;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * The OpenAPI groups the capability modules registered, springdoc or not (this type names no springdoc class).
 *
 * <p>A capability registers one group when it builds its {@code GroupedOpenApi} through
 * {@code DatumOpenApiSupport.group(...)}; the registry lets tests, the actuator info and tooling list what the
 * application documents without loading springdoc.
 */
public final class DatumOpenApiRegistry {

    /**
     * One documented group.
     *
     * @param name          the springdoc group name ({@code datum-forms})
     * @param pathsToMatch  the path patterns that belong to it
     * @param disabledPaths path patterns of endpoints switched off ({@code datum.web.api.endpoints.*}), hidden from the document
     */
    public record Group(String name, List<String> pathsToMatch, List<String> disabledPaths) {

        public Group {
            pathsToMatch = List.copyOf(pathsToMatch);
            disabledPaths = List.copyOf(disabledPaths);
        }
    }

    private final List<Group> groups = new CopyOnWriteArrayList<>();

    public void register(Group group) {
        groups.add(group);
    }

    public List<Group> groups() {
        return List.copyOf(groups);
    }
}
