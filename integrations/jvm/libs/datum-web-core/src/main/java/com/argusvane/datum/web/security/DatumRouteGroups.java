package com.argusvane.datum.web.security;

import com.argusvane.datum.web.WebSettings;
import com.argusvane.datum.web.openapi.DatumEndpointCatalog;
import com.argusvane.datum.web.openapi.DatumEndpointCatalog.Base;
import com.argusvane.datum.web.openapi.DatumEndpointCatalog.Endpoint;
import java.util.ArrayList;
import java.util.Collections;
import java.util.EnumMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * Datum's routes grouped by what an application secures them for (framework-first). Who may call a Datum route is the application's security, not a Datum policy: a binding turns
 * each group into its framework's request matchers (Spring Security's {@code RequestMatcher} and
 * {@code ServerWebExchangeMatcher} in datum-spring-web), so an application writes
 * {@code requestMatchers(datum.builderWrites()).hasRole("EDITOR")} and keeps one rule per capability however the
 * paths are configured. The routes come from {@link DatumEndpointCatalog}, so a route the catalog gains or loses
 * shows up here or fails {@code DatumRouteGroupsTest}.
 *
 * <p>One route is split by its query: {@code GET {api}/forms/{key}/definition} serves the public copy (no
 * server-secret rule) unless {@code public} is given with a value other than {@code true}, when it serves the
 * full definition. That copy is the builder's (the author's copy, which keeps the server-secret rules, BLD-08), so the
 * public request is in {@link Group#FORMS_READ} and the full one in
 * {@link Group#BUILDER_READS}, and the two never overlap: a request with any {@code public} value other than
 * {@code true} (including {@code public=true&public=false}, which the endpoint refuses 400) counts as the builder's.
 *
 * <p>A {@code GET} route also answers {@code HEAD} (both web stacks serve it implicitly), so its matchers take both.
 */
public final class DatumRouteGroups {

    /** What the application secures a set of routes for. The method names are the binding's matcher methods. */
    public enum Group {
        /** The public copy of a definition and its translations: what a page that shows a form reads. */
        FORMS_READ("formsRead"),
        /** The full definition with its server-secret rules ({@code ?public=false}): for people who build. */
        BUILDER_READS("builderReads"),
        /** The builder's writes: create, save and save the translations of a form. */
        BUILDER_WRITES("builderWrites"),
        /** A data source's options. */
        DATA_SOURCES("dataSources"),
        /** A delivery ({@code POST {api}/submissions}): what sending a form posts. */
        SUBMISSIONS("submissions"),
        /** A journey page's or journey's check ({@code POST {api}/submissions/validate}): what filling a form posts. */
        VALIDATE("validate"),
        /** The dry run ({@code POST {api}/submissions/test}): the builder's test of a form, for people who build. */
        DRY_RUN("dryRun"),
        /** The kernel's inspection of a definition ({@code POST {api}/inspect}): for operators. */
        INSPECT("inspect"),
        /** A PDF of posted answers: render, fill and sign. */
        PDF("pdf"),
        /** A posted PDF's signatures checked, and the server's signing chain. */
        PDF_VERIFY("pdfVerify"),
        /** The passkey ceremony and a person's passkeys ({@code datum.webauthn.path}). */
        PASSKEYS("passkeys"),
        /** The RFC 3161 timestamp server ({@code datum.tsa.path}); it authenticates its own clients by key. */
        TSA("tsa");

        private final String method;

        Group(String method) {
            this.method = method;
        }

        /** The binding's matcher method for this group ({@code builderWrites}). */
        public String method() {
            return method;
        }
    }

    /** Which copy of a definition a request asks for, by its {@code public} query values. */
    public enum Copy {
        /** The route has no copy to choose. */
        ANY,
        /** No {@code public} value, or only {@code true}: the public copy. */
        PUBLIC,
        /** Any {@code public} value other than {@code true}: the full definition. */
        FULL;

        /**
         * Whether a request with these {@code public} query values (decoded, as the web stack reads them; null or
         * empty when the parameter is absent) asks for this copy.
         */
        public boolean admits(List<String> publicValues) {
            if (this == ANY) {
                return true;
            }
            boolean publicCopy = publicValues == null || publicValues.stream().allMatch("true"::equals);
            return this == PUBLIC ? publicCopy : !publicCopy;
        }
    }

    /**
     * One route of a group.
     *
     * @param group    the group
     * @param endpoint the catalog's route
     * @param copy     the copy it is limited to ({@link Copy#ANY} but for the definition route)
     */
    public record Route(Group group, Endpoint endpoint, Copy copy) {

        public Route {
            Objects.requireNonNull(group, "group");
            Objects.requireNonNull(endpoint, "endpoint");
            Objects.requireNonNull(copy, "copy");
        }

        /** The HTTP methods it answers: its own, and {@code HEAD} beside a {@code GET}. */
        public List<String> methods() {
            return "GET".equals(endpoint.method()) ? List.of("GET", "HEAD") : List.of(endpoint.method());
        }

        /** The path pattern under the configured base ({@code /api} + {@code /forms/{key}/definition}). */
        public String pattern(Map<Base, String> bases) {
            return endpoint.path(basePath(endpoint.base(), bases == null ? null : bases.get(endpoint.base())));
        }
    }

    /** The groups of each catalog route, by operation id; the definition route is in two, split by its copy. */
    private static final Map<String, List<Map.Entry<Group, Copy>>> BY_OPERATION = new LinkedHashMap<>();

    static {
        put("getFormDefinition", Group.FORMS_READ, Copy.PUBLIC);
        put("getFormDefinition", Group.BUILDER_READS, Copy.FULL);
        put("getFormTranslations", Group.FORMS_READ, Copy.ANY);
        put("getDataSourceItems", Group.DATA_SOURCES, Copy.ANY);
        put("createForm", Group.BUILDER_WRITES, Copy.ANY);
        put("saveForm", Group.BUILDER_WRITES, Copy.ANY);
        put("saveFormTranslations", Group.BUILDER_WRITES, Copy.ANY);
        put("submitSubmission", Group.SUBMISSIONS, Copy.ANY);
        put("validateSubmission", Group.VALIDATE, Copy.ANY);
        put("testSubmission", Group.DRY_RUN, Copy.ANY);
        put("inspectDefinition", Group.INSPECT, Copy.ANY);
        put("renderPdf", Group.PDF, Copy.ANY);
        put("fillPdf", Group.PDF, Copy.ANY);
        put("signPdf", Group.PDF, Copy.ANY);
        put("verifyPdf", Group.PDF_VERIFY, Copy.ANY);
        put("serverCertificate", Group.PDF_VERIFY, Copy.ANY);
        put("issueTimestamp", Group.TSA, Copy.ANY);
        put("getTimestampCertificate", Group.TSA, Copy.ANY);
        put("getTimestampCertificates", Group.TSA, Copy.ANY);
        put("passkeyChallenge", Group.PASSKEYS, Copy.ANY);
        put("passkeyRegister", Group.PASSKEYS, Copy.ANY);
        put("listPasskeys", Group.PASSKEYS, Copy.ANY);
        put("removePasskey", Group.PASSKEYS, Copy.ANY);
        put("passkeyCheckChallenge", Group.PASSKEYS, Copy.ANY);
        put("passkeyCheck", Group.PASSKEYS, Copy.ANY);
    }

    private DatumRouteGroups() {
    }

    private static void put(String operationId, Group group, Copy copy) {
        BY_OPERATION.computeIfAbsent(operationId, id -> new ArrayList<>()).add(Map.entry(group, copy));
    }

    /** The operation ids grouped here (a test holds them equal to the catalog's). */
    static List<String> operationIds() {
        return List.copyOf(BY_OPERATION.keySet());
    }

    /** Every route by group, in the catalog's order. */
    public static Map<Group, List<Route>> all() {
        Map<Group, List<Route>> out = new EnumMap<>(Group.class);
        for (Group group : Group.values()) {
            out.put(group, new ArrayList<>());
        }
        for (Endpoint endpoint : DatumEndpointCatalog.endpoints()) {
            for (Map.Entry<Group, Copy> entry : BY_OPERATION.getOrDefault(endpoint.operationId(), List.of())) {
                out.get(entry.getKey()).add(new Route(entry.getKey(), endpoint, entry.getValue()));
            }
        }
        out.replaceAll((group, routes) -> List.copyOf(routes));
        return Collections.unmodifiableMap(out);
    }

    /** The routes of one group. */
    public static List<Route> routes(Group group) {
        return all().get(group);
    }

    /**
     * A configured base path as the capability that serves it normalises it (one leading slash, no trailing slash),
     * the base's default when blank: {@code datum.web.api.path} as {@link WebSettings#normalise}, {@code datum.tsa.path}
     * also turning {@code /} into {@code /tsa} (TsaSettings), {@code datum.webauthn.path} as given (an empty one
     * fails that module's start, so its default is used here).
     */
    public static String basePath(Base base, String configured) {
        String path = WebSettings.normalise(configured, base.defaultPath());
        return path.equals("/") && base == Base.TSA ? base.defaultPath() : path;
    }
}
