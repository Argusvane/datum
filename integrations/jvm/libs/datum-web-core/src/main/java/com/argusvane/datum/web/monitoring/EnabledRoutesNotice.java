package com.argusvane.datum.web.monitoring;

import com.argusvane.datum.core.DatumStartupCheck;
import com.argusvane.datum.web.WebSettings;
import com.argusvane.datum.web.openapi.DatumEndpointCatalog;
import com.argusvane.datum.web.openapi.DatumEndpointCatalog.Endpoint;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.function.Predicate;
import java.util.function.Supplier;

/**
 * The start-up notice ("every endpoint off by default"): one INFO line listing the Datum routes that are
 * on (method, path, the switch that turned each on), or, when none is, the sentence that names the properties to set.
 * A starter on the classpath registers no route until the application says so, so an operator who sees a 404 where
 * they expected a route finds the cause in the first lines of the log.
 *
 * <p>The routes come from {@link DatumEndpointCatalog}, so a route the catalog gains is listed without a change here.
 * A route counts as on when its capability is present ({@link DatumCapabilities}: the module is on the classpath and
 * configured) and its switch is on; the binding answers the second question in its framework's terms (Spring:
 * {@code Environment}). The line's shape is framework-free, so another binding writes the same words.
 */
public final class EnabledRoutesNotice {

    /** The category it is written under, as the other {@code datum-web-core} start-up lines. */
    public static final String CATEGORY = "datum.web";

    /** The sentence of an application that enabled nothing. */
    public static final String NONE = "Datum: no Datum route is enabled; set datum.web.api.endpoints.*, datum.web.assets.enabled, "
        + "datum.builder.enabled, datum.tsa.enabled or datum.webauthn.enabled to serve one (docs/spring.md, \"Switches per story\").";

    private EnabledRoutesNotice() {
    }

    /**
     * What the binding found once every bean exists.
     *
     * @param settings     the web settings (the API base path, the assets path)
     * @param capabilities the capabilities present, by their catalog name ({@code forms}, {@code ui}, {@code submissions}, ...)
     * @param bases        the registered paths of the TSA and passkey bases ({@link DatumCapabilities#endpoints}), by name
     * @param assetsServed whether the asset routes are actually served (switch on and a manifest on the classpath)
     * @param switchOn     whether a catalog switch ({@code datum.builder.enabled}, ...) is on
     */
    public record Facts(WebSettings settings, Set<String> capabilities, Map<String, String> bases, boolean assetsServed,
                        Predicate<String> switchOn) {

        public Facts {
            Objects.requireNonNull(settings, "settings");
            capabilities = Set.copyOf(capabilities);
            bases = Map.copyOf(bases);
            Objects.requireNonNull(switchOn, "switchOn");
        }
    }

    /** The check, asked when it runs (after every bean exists). */
    public static DatumStartupCheck check(Supplier<Facts> facts) {
        Objects.requireNonNull(facts, "facts");
        return () -> List.of(notice(facts.get()));
    }

    /** The notice for these facts. */
    public static DatumStartupCheck.Notice notice(Facts facts) {
        List<String> lines = new ArrayList<>();
        for (Endpoint endpoint : DatumEndpointCatalog.endpoints()) {
            if (!facts.capabilities().contains(endpoint.capability()) || !facts.switchOn().test(endpoint.switchKey())) {
                continue;
            }
            lines.add(endpoint.method() + " " + endpoint.path(basePath(endpoint, facts)) + " (" + endpoint.switchKey() + ")");
        }
        if (facts.assetsServed()) {
            lines.add("GET " + facts.settings().assets().path() + "/** (datum.web.assets.enabled)");
        }
        if (lines.isEmpty()) {
            return DatumStartupCheck.Notice.info(CATEGORY, NONE);
        }
        return DatumStartupCheck.Notice.info(CATEGORY, "Datum routes enabled (" + lines.size() + "):\n  " + String.join("\n  ", lines));
    }

    private static String basePath(Endpoint endpoint, Facts facts) {
        return switch (endpoint.base()) {
            case API -> facts.settings().api().path();
            case TSA -> facts.bases().getOrDefault("tsa", endpoint.base().defaultPath());
            case WEBAUTHN -> facts.bases().getOrDefault("webauthn", endpoint.base().defaultPath());
        };
    }
}
