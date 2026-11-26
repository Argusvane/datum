package com.argusvane.datum.springweb.webflux;

import com.argusvane.datum.web.WebSettings;
import com.argusvane.datum.web.openapi.DatumEndpointCatalog.Base;
import com.argusvane.datum.web.security.DatumRouteGroups;
import com.argusvane.datum.web.security.DatumRouteGroups.Copy;
import com.argusvane.datum.web.security.DatumRouteGroups.Group;
import com.argusvane.datum.web.security.DatumRouteGroups.Route;
import java.util.ArrayList;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpMethod;
import org.springframework.security.web.server.util.matcher.OrServerWebExchangeMatcher;
import org.springframework.security.web.server.util.matcher.PathPatternParserServerWebExchangeMatcher;
import org.springframework.security.web.server.util.matcher.ServerWebExchangeMatcher;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Mono;

/**
 * The WebFlux twin of {@code DatumRequestMatchers} (framework-first): Spring Security
 * {@link ServerWebExchangeMatcher}s for Datum's routes, one set per capability, built from the configured paths, for
 * {@code authorizeExchange(exchanges -> exchanges.matchers(datum.builderWrites()).hasRole("EDITOR"))}. They are
 * {@link PathPatternParserServerWebExchangeMatcher}s (the path within the application), so a path variable reaches
 * an {@code AuthorizationContext} the standard way. The full definition ({@code ?public=false}) is
 * {@link #builderReads()}, never {@link #formsRead()}; a {@code GET} route also takes {@code HEAD}. A bean of this
 * type exists when Spring Security is on the classpath of a reactive application; it secures nothing by itself.
 */
public final class DatumExchangeMatchers {

    private final Map<Group, ServerWebExchangeMatcher> groups = new EnumMap<>(Group.class);
    private final ServerWebExchangeMatcher assets;
    private final ServerWebExchangeMatcher all;

    /**
     * @param bases      the configured base paths; a missing one is its default
     * @param assetsPath {@code datum.web.assets.path}
     */
    public DatumExchangeMatchers(Map<Base, String> bases, String assetsPath) {
        List<ServerWebExchangeMatcher> every = new ArrayList<>();
        DatumRouteGroups.all().forEach((group, routes) -> {
            List<ServerWebExchangeMatcher> matchers = new ArrayList<>();
            for (Route route : routes) {
                matchers.add(matcher(route, bases));
            }
            ServerWebExchangeMatcher matcher = new OrServerWebExchangeMatcher(matchers);
            groups.put(group, matcher);
            every.add(matcher);
        });
        String assetPattern = WebSettings.normalise(assetsPath, WebSettings.Assets.DEFAULT_PATH) + "/**";
        this.assets = new OrServerWebExchangeMatcher(new PathPatternParserServerWebExchangeMatcher(assetPattern, HttpMethod.GET),
            new PathPatternParserServerWebExchangeMatcher(assetPattern, HttpMethod.HEAD));
        every.add(assets);
        this.all = new OrServerWebExchangeMatcher(every);
    }

    private static ServerWebExchangeMatcher matcher(Route route, Map<Base, String> bases) {
        String pattern = route.pattern(bases);
        List<ServerWebExchangeMatcher> methods = new ArrayList<>();
        for (String method : route.methods()) {
            methods.add(new PathPatternParserServerWebExchangeMatcher(pattern, HttpMethod.valueOf(method)));
        }
        ServerWebExchangeMatcher path = methods.size() == 1 ? methods.get(0) : new OrServerWebExchangeMatcher(methods);
        return route.copy() == Copy.ANY ? path : new CopyMatcher(path, route.copy());
    }

    /** The public copy of a definition and its translations. */
    public ServerWebExchangeMatcher formsRead() {
        return groups.get(Group.FORMS_READ);
    }

    /** The full definition ({@code ?public=false}) and the form list: for people who build. */
    public ServerWebExchangeMatcher builderReads() {
        return groups.get(Group.BUILDER_READS);
    }

    /** The builder's writes. */
    public ServerWebExchangeMatcher builderWrites() {
        return groups.get(Group.BUILDER_WRITES);
    }

    /** {@code GET {api}/data-sources/{id}}. */
    public ServerWebExchangeMatcher dataSources() {
        return groups.get(Group.DATA_SOURCES);
    }

    /** A delivery: {@code POST {api}/submissions}. */
    public ServerWebExchangeMatcher submissions() {
        return groups.get(Group.SUBMISSIONS);
    }

    /** A journey page's or journey's check: {@code POST {api}/submissions/validate}. */
    public ServerWebExchangeMatcher validate() {
        return groups.get(Group.VALIDATE);
    }

    /** The dry run. */
    public ServerWebExchangeMatcher dryRun() {
        return groups.get(Group.DRY_RUN);
    }

    /** The kernel's inspection. */
    public ServerWebExchangeMatcher inspect() {
        return groups.get(Group.INSPECT);
    }

    /** A PDF of posted answers: render, fill, sign. */
    public ServerWebExchangeMatcher pdf() {
        return groups.get(Group.PDF);
    }

    /** A posted PDF checked, and the server's signing chain. */
    public ServerWebExchangeMatcher pdfVerify() {
        return groups.get(Group.PDF_VERIFY);
    }

    /** Every passkey route. */
    public ServerWebExchangeMatcher passkeys() {
        return groups.get(Group.PASSKEYS);
    }

    /** The timestamp server (it checks its own client keys). */
    public ServerWebExchangeMatcher tsa() {
        return groups.get(Group.TSA);
    }

    /** The versioned assets and {@code host.json}. */
    public ServerWebExchangeMatcher assets() {
        return assets;
    }

    /** Every Datum route above: where an application installs {@link DatumServerSecurityResponses}. */
    public ServerWebExchangeMatcher all() {
        return all;
    }

    /** One group's matcher. */
    public ServerWebExchangeMatcher group(Group group) {
        return groups.get(group);
    }

    /** The definition route limited to one copy by its {@code public} values; the path variables pass through. */
    private record CopyMatcher(ServerWebExchangeMatcher path, Copy copy) implements ServerWebExchangeMatcher {

        @Override
        public Mono<MatchResult> matches(ServerWebExchange exchange) {
            return path.matches(exchange).flatMap(result -> !result.isMatch()
                || copy.admits(exchange.getRequest().getQueryParams().get("public")) ? Mono.just(result) : MatchResult.notMatch());
        }
    }
}
