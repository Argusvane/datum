package com.argusvane.datum.springweb.webflux;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.CopyOnWriteArrayList;
import org.springframework.http.server.PathContainer;
import org.springframework.web.util.pattern.PathPattern;
import org.springframework.web.util.pattern.PathPatternParser;

/**
 * The methods Datum serves on its WebFlux paths, kept so a wrong method can answer 405 with an {@code Allow}
 * header naming all of them, as Spring MVC answers from every mapping of a path.
 *
 * <p>Why a registry and not a fallback route in each capability's router: a functional router is tried in bean
 * order and the first route that matches wins, whatever its method, and WebFlux consults every router function
 * before any annotated controller. A path-wide 405 route therefore took the path away from an application's own
 * {@code DELETE} on it, router function or {@code @DeleteMapping}. The registry is read by
 * {@link DatumMethodNotAllowedMapping}, a handler mapping ordered after the annotated controllers and the router
 * functions, so it answers only a request nothing else would handle. Each capability registers the methods it
 * serves; the union per path is the {@code Allow} value.
 *
 * <p>The patterns are Spring's own {@link PathPattern}s (framework-first), so the rules read a path the
 * way the router that serves it does. Spring MVC needs none of this: it answers its own 405 from its mappings.
 */
public final class DatumMethodRules {

    private record Rule(PathPattern pattern, Set<String> methods) {
    }

    private static final List<String> ORDER = List.of("GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE");

    private final PathPatternParser parser = new PathPatternParser();
    private final List<Rule> rules = new CopyOnWriteArrayList<>();

    /** Records that {@code methods} are served on {@code path} (a path pattern such as {@code /api/forms/{key}}). */
    public DatumMethodRules allow(String path, String... methods) {
        rules.add(new Rule(parser.parse(path), Set.copyOf(Arrays.asList(methods))));
        return this;
    }

    /** Whether any rule names this path (the path within the application). */
    public boolean knows(PathContainer path) {
        for (Rule rule : rules) {
            if (rule.pattern.matches(path)) {
                return true;
            }
        }
        return false;
    }

    /**
     * The methods served on a path, in the order GET, HEAD, POST, PUT, PATCH, DELETE: the {@code Allow} value
     * without commas.
     */
    public List<String> allowed(PathContainer path) {
        Set<String> union = new TreeSet<>();
        for (Rule rule : rules) {
            if (rule.pattern.matches(path)) {
                union.addAll(rule.methods);
            }
        }
        List<String> ordered = new ArrayList<>();
        for (String method : ORDER) {
            if (union.remove(method)) {
                ordered.add(method);
            }
        }
        ordered.addAll(union);
        return ordered;
    }

    /** {@link #allowed(PathContainer)} for a path given as text (tests, tools). */
    public List<String> allowed(String path) {
        return allowed(PathContainer.parsePath(path));
    }

    /** {@link #knows(PathContainer)} for a path given as text. */
    public boolean knows(String path) {
        return knows(PathContainer.parsePath(path));
    }
}
