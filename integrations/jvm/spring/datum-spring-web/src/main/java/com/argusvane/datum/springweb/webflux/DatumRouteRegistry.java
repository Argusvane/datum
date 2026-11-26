package com.argusvane.datum.springweb.webflux;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import org.springframework.http.server.PathContainer;
import org.springframework.web.util.pattern.PathPattern;
import org.springframework.web.util.pattern.PathPatternParser;

/**
 * The URL patterns that belong to Datum, for the WebFlux exception handler.
 *
 * <p>A WebFlux {@code WebExceptionHandler} sees every failing request of the application, so it answers only
 * the ones whose path was registered here by a capability module (for example {@code /api/submissions/**} or
 * the assets path) and passes the rest on untouched. The patterns are Spring's own {@link PathPattern}s (framework-first), matched against
 * the {@link PathContainer} the request carries, relative to the application (the context or base path is not part
 * of them). The MVC side does not need it: the advice keys on the binding's {@code DatumController}.
 */
public final class DatumRouteRegistry {

    private final PathPatternParser parser = new PathPatternParser();
    private final List<PathPattern> patterns = new CopyOnWriteArrayList<>();

    /** Adds patterns such as {@code /api/forms/**}; duplicates are harmless. */
    public DatumRouteRegistry register(String... paths) {
        for (String path : paths) {
            patterns.add(parser.parse(path));
        }
        return this;
    }

    /** Whether the path within the application, as the request carries it, is a Datum route. */
    public boolean matches(PathContainer path) {
        for (PathPattern pattern : patterns) {
            if (pattern.matches(path)) {
                return true;
            }
        }
        return false;
    }

    /** {@link #matches(PathContainer)} for a path given as text (tests, tools). */
    public boolean matches(String path) {
        return matches(PathContainer.parsePath(path));
    }

    /** The registered patterns, as written. */
    public List<String> patterns() {
        return patterns.stream().map(PathPattern::getPatternString).toList();
    }
}
