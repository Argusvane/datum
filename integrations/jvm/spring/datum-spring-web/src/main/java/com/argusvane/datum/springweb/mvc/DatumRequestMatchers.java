package com.argusvane.datum.springweb.mvc;

import com.argusvane.datum.web.WebSettings;
import com.argusvane.datum.web.openapi.DatumEndpointCatalog.Base;
import com.argusvane.datum.web.security.DatumRouteGroups;
import com.argusvane.datum.web.security.DatumRouteGroups.Copy;
import com.argusvane.datum.web.security.DatumRouteGroups.Group;
import com.argusvane.datum.web.security.DatumRouteGroups.Route;
import jakarta.servlet.http.HttpServletRequest;
import java.util.ArrayList;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpMethod;
import org.springframework.security.web.servlet.util.matcher.PathPatternRequestMatcher;
import org.springframework.security.web.util.matcher.OrRequestMatcher;
import org.springframework.security.web.util.matcher.RequestMatcher;

/**
 * Spring Security request matchers for Datum's routes, one set per capability, built from the configured paths
 * (framework-first). Who may call a Datum route is the
 * application's security, so Datum ships no access policy: the application writes its rules with these, and they
 * follow {@code datum.web.api.path}, {@code datum.web.assets.path}, {@code datum.tsa.path} and
 * {@code datum.webauthn.path} wherever they move, as the settings beans hold them (an application's own
 * {@code WebSettings}, {@code TsaSettings} or {@code PasskeySettings} bean moves the matchers with the routes).
 *
 * <pre>{@code
 * http.authorizeHttpRequests(requests -> requests
 *     .requestMatchers(datum.builderWrites(), datum.builderReads(), datum.dryRun(), datum.inspect()).hasRole("EDITOR")
 *     .requestMatchers(datum.dataSources()).authenticated()
 *     .requestMatchers(datum.formsRead(), datum.submissions(), datum.validate(), datum.assets()).permitAll()
 *     .anyRequest().authenticated());
 * }</pre>
 *
 * <p>The matchers are Spring Security's {@link PathPatternRequestMatcher}s (the path within the application, so
 * the context path is never part of the pattern), so a path variable ({@code key}, {@code id}) reaches an
 * {@code AuthorizationManager} through {@code RequestAuthorizationContext.getVariables()}, the standard way: that is
 * the per-form recipe ({@code access((authentication, context) -> ...)}). A definition route's {@code key} may carry
 * the catalog's {@code @version} suffix; a rule that names forms strips it. A {@code GET} route's matcher also takes
 * {@code HEAD}. The full definition ({@code ?public=false}) is {@link #builderReads()}, never {@link #formsRead()}
 * (see {@link DatumRouteGroups}). A bean of this type exists when Spring Security is on the classpath of a servlet
 * application; it secures nothing by itself.
 */
public final class DatumRequestMatchers {

    private final Map<Group, RequestMatcher> groups = new EnumMap<>(Group.class);
    private final RequestMatcher assets;
    private final RequestMatcher all;

    /**
     * @param bases      the configured base paths ({@code /api}, {@code /tsa}, {@code /api/webauthn}); a missing one is
     *                   its default
     * @param assetsPath {@code datum.web.assets.path}
     */
    public DatumRequestMatchers(Map<Base, String> bases, String assetsPath) {
        List<RequestMatcher> every = new ArrayList<>();
        DatumRouteGroups.all().forEach((group, routes) -> {
            List<RequestMatcher> matchers = new ArrayList<>();
            for (Route route : routes) {
                matchers.add(matcher(route, bases));
            }
            RequestMatcher matcher = new OrRequestMatcher(matchers);
            groups.put(group, matcher);
            every.add(matcher);
        });
        String assetPattern = WebSettings.normalise(assetsPath, WebSettings.Assets.DEFAULT_PATH) + "/**";
        this.assets = new OrRequestMatcher(PathPatternRequestMatcher.withDefaults().matcher(HttpMethod.GET, assetPattern),
            PathPatternRequestMatcher.withDefaults().matcher(HttpMethod.HEAD, assetPattern));
        every.add(assets);
        this.all = new OrRequestMatcher(every);
    }

    private static RequestMatcher matcher(Route route, Map<Base, String> bases) {
        String pattern = route.pattern(bases);
        List<RequestMatcher> methods = new ArrayList<>();
        for (String method : route.methods()) {
            methods.add(PathPatternRequestMatcher.withDefaults().matcher(HttpMethod.valueOf(method), pattern));
        }
        RequestMatcher path = methods.size() == 1 ? methods.get(0) : new OrRequestMatcher(methods);
        return route.copy() == Copy.ANY ? path : new CopyMatcher(path, route.copy());
    }

    /** The public copy of a definition and its translations. */
    public RequestMatcher formsRead() {
        return groups.get(Group.FORMS_READ);
    }

    /** The full definition with its server-secret rules ({@code ?public=false}) and the form list: for people who build. */
    public RequestMatcher builderReads() {
        return groups.get(Group.BUILDER_READS);
    }

    /** The builder's writes: {@code POST {api}/forms}, {@code PUT {api}/forms/{key}} and its translations. */
    public RequestMatcher builderWrites() {
        return groups.get(Group.BUILDER_WRITES);
    }

    /** {@code GET {api}/data-sources/{id}}. */
    public RequestMatcher dataSources() {
        return groups.get(Group.DATA_SOURCES);
    }

    /** A delivery: {@code POST {api}/submissions}. */
    public RequestMatcher submissions() {
        return groups.get(Group.SUBMISSIONS);
    }

    /** A journey page's or journey's check: {@code POST {api}/submissions/validate}. */
    public RequestMatcher validate() {
        return groups.get(Group.VALIDATE);
    }

    /** The dry run, {@code POST {api}/submissions/test}. */
    public RequestMatcher dryRun() {
        return groups.get(Group.DRY_RUN);
    }

    /** The kernel's inspection, {@code POST {api}/inspect}. */
    public RequestMatcher inspect() {
        return groups.get(Group.INSPECT);
    }

    /** A PDF of posted answers: {@code POST {api}/pdf}, {@code /pdf/fill}, {@code /pdf/sign}. */
    public RequestMatcher pdf() {
        return groups.get(Group.PDF);
    }

    /** {@code POST {api}/pdf/verify} and {@code GET {api}/server/certificate}. */
    public RequestMatcher pdfVerify() {
        return groups.get(Group.PDF_VERIFY);
    }

    /** Every passkey route under {@code datum.webauthn.path}. */
    public RequestMatcher passkeys() {
        return groups.get(Group.PASSKEYS);
    }

    /** The timestamp server under {@code datum.tsa.path} (it checks its own client keys). */
    public RequestMatcher tsa() {
        return groups.get(Group.TSA);
    }

    /** The versioned assets and {@code host.json} under {@code datum.web.assets.path}. */
    public RequestMatcher assets() {
        return assets;
    }

    /** Every Datum route above: where an application installs {@link DatumSecurityResponses}. */
    public RequestMatcher all() {
        return all;
    }

    /** One group's matcher. */
    public RequestMatcher group(Group group) {
        return groups.get(group);
    }

    /** The definition route limited to one copy by its {@code public} values; the path variables pass through. */
    private record CopyMatcher(RequestMatcher path, Copy copy) implements RequestMatcher {

        @Override
        public boolean matches(HttpServletRequest request) {
            return matcher(request).isMatch();
        }

        @Override
        public MatchResult matcher(HttpServletRequest request) {
            MatchResult result = path.matcher(request);
            if (!result.isMatch()) {
                return result;
            }
            String[] values = request.getParameterValues("public");
            return copy.admits(values == null ? null : List.of(values)) ? result : MatchResult.notMatch();
        }
    }
}
