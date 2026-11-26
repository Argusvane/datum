package com.argusvane.datum.springweb.spring;

import com.argusvane.datum.web.WebSettings;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;
import org.springframework.util.unit.DataSize;

/**
 * The root {@code datum.*} properties: {@code datum.enabled} and everything under {@code datum.web.*}.
 *
 * <p>Constructor-bound records: Spring Boot's own idiom for immutable
 * configuration, with {@link DefaultValue} naming each default for the configuration metadata. A compact constructor
 * fills a missing member from the same constants the libraries use, so {@link #defaults()} (a context that binds
 * nothing, a test) and a bound object agree; a test holds both equal to {@link WebSettings#defaults()}.
 *
 * <p>Other capability modules bind their own prefixes ({@code datum.runtime}, {@code datum.builder},
 * {@code datum.pdf}, ...) in their own classes; unknown children of {@code datum} are ignored here.
 * {@link Web.Throttle} is only a holder: the submissions module reads it and does the throttling.
 *
 * <p>The Spring binding of {@link WebSettings}: {@link #toSettings()} is what the libraries read.
 *
 * @param enabled master switch: with false no Datum auto-configuration applies
 * @param web     {@code datum.web.*}
 */
@ConfigurationProperties(prefix = "datum")
public record DatumProperties(@DefaultValue("true") boolean enabled, @DefaultValue Web web) {

    public DatumProperties {
        web = web == null ? Web.defaults() : web;
    }

    /** What an application that set nothing runs with. */
    public static DatumProperties defaults() {
        return new DatumProperties(true, Web.defaults());
    }

    /** These properties as the libraries' settings. */
    public WebSettings toSettings() {
        Web.Api api = web.api();
        Web.Assets assets = web.assets();
        Web.Csrf csrf = web.csrf();
        Web.Throttle throttle = web.throttle();
        Web.Openapi openapi = web.openapi();
        return new WebSettings(enabled,
            new WebSettings.Api(api.path(), api.maxBodySize().toBytes(), api.problemDetails(), api.endpoints(), api.busyRetryAfter()),
            new WebSettings.Assets(assets.enabled(), assets.path(), assets.cachePeriod(), assets.omitFeatures()),
            new WebSettings.Csrf(csrf.headerName(), csrf.cookieName(), csrf.metaName()),
            new WebSettings.Throttle(throttle.enabled(), throttle.limit(), throttle.window(), throttle.by()),
            new WebSettings.OpenApi(openapi.enabled(), openapi.groupPrefix()));
    }

    /**
     * {@code datum.web.*}.
     *
     * @param api     {@code datum.web.api.*}
     * @param assets  {@code datum.web.assets.*}
     * @param csrf    {@code datum.web.csrf.*}
     * @param throttle {@code datum.web.throttle.*}
     * @param openapi {@code datum.web.openapi.*}
     */
    public record Web(@DefaultValue Api api, @DefaultValue Assets assets, @DefaultValue Csrf csrf, @DefaultValue Throttle throttle,
                      @DefaultValue Openapi openapi) {

        public Web {
            api = api == null ? Api.defaults() : api;
            assets = assets == null ? Assets.defaults() : assets;
            csrf = csrf == null ? Csrf.defaults() : csrf;
            throttle = throttle == null ? Throttle.defaults() : throttle;
            openapi = openapi == null ? Openapi.defaults() : openapi;
        }

        static Web defaults() {
            return new Web(null, null, null, null, null);
        }

        /**
         * {@code datum.web.api.*}.
         *
         * @param path           where the JSON endpoints live (no trailing slash)
         * @param maxBodySize    the largest request body a JSON endpoint reads; counted on the raw stream before parsing
         * @param problemDetails answer errors as RFC 9457 problem details ({@code application/problem+json}) with the same codes
         * @param endpoints      per endpoint switches ({@code submissions}, {@code validate}, {@code definition}, ...)
         * @param busyRetryAfter the {@code Retry-After} a {@code server.busy} 503 carries; whole seconds from 1 s to 1 h
         */
        public record Api(@DefaultValue("/api") String path, @DefaultValue("1MB") DataSize maxBodySize,
                          @DefaultValue("false") boolean problemDetails, Map<String, Boolean> endpoints,
                          @DefaultValue("5s") Duration busyRetryAfter) {

            public Api {
                path = WebSettings.normalise(path, WebSettings.Api.DEFAULT_PATH);
                maxBodySize = maxBodySize == null ? DataSize.ofBytes(WebSettings.Api.DEFAULT_MAX_BODY_BYTES) : maxBodySize;
                endpoints = endpoints == null ? Map.of() : Map.copyOf(endpoints);
                busyRetryAfter = busyRetryAfter == null ? WebSettings.Api.DEFAULT_BUSY_RETRY_AFTER : busyRetryAfter;
            }

            static Api defaults() {
                return new Api(null, null, false, null, null);
            }

            /** Whether an endpoint is on: only when switched on; every endpoint is off by default. */
            public boolean endpointEnabled(String name) {
                return Boolean.TRUE.equals(endpoints.get(name));
            }
        }

        /**
         * {@code datum.web.assets.*}.
         *
         * @param enabled      serve the bundles from the classpath under the versioned path (off by default)
         * @param path         where the assets are served (no trailing slash); files live at {path}/{buildId}/...
         * @param cachePeriod  the max-age of the immutable asset responses
         * @param omitFeatures feature tokens whose files answer 404; added to what the build already left out
         */
        public record Assets(@DefaultValue("false") boolean enabled, @DefaultValue("/datum/assets") String path,
                             @DefaultValue("365d") Duration cachePeriod, List<String> omitFeatures) {

            public Assets {
                path = WebSettings.normalise(path, WebSettings.Assets.DEFAULT_PATH);
                cachePeriod = cachePeriod == null ? Duration.ofDays(365) : cachePeriod;
                omitFeatures = omitFeatures == null ? List.of() : List.copyOf(omitFeatures);
            }

            static Assets defaults() {
                return new Assets(false, null, null, null);
            }
        }

        /**
         * {@code datum.web.csrf.*}: the names the page glue reads (the token itself is Spring Security's).
         */
        public record Csrf(@DefaultValue("X-XSRF-TOKEN") String headerName, @DefaultValue("XSRF-TOKEN") String cookieName,
                           @DefaultValue("_csrf") String metaName) {

            static Csrf defaults() {
                return new Csrf("X-XSRF-TOKEN", "XSRF-TOKEN", "_csrf");
            }
        }

        /**
         * {@code datum.web.throttle.*}: read by the submissions module; this module only holds the values.
         *
         * @param limits  the development throttle's limit per route kind ({@code submit}, {@code validate}, {@code test}, {@code pdf},
         *                {@code register}); a kind not listed uses {@code limit}. Binding-level: an application's own throttle bean ignores it
         * @param maxKeys the most windows the development throttle holds (16 to 10,000,000); when full the expired ones go first, then a
         *                sixteenth of the live windows, one at a time from the caller (address and principal) holding the most: its window with
         *                the fewest attempts first, the newest among equals
         * @param addressLimit the requests one client address may send per window to every throttled route together (submit, validate,
         *                test, pdf, register), counted after the Content-Type check and before the body is read, so a body that never parses
         *                counts too; at least 1, or 0 to keep no address limit. Ten times the default {@code limit}, so many people behind
         *                one NAT still get through. Binding-level: an application's own throttle bean keeps its own address limit or none
         */
        public record Throttle(@DefaultValue("true") boolean enabled, @DefaultValue("60") int limit, @DefaultValue("1m") Duration window,
                               @DefaultValue({"ip", "form"}) List<String> by, Map<String, Integer> limits,
                               @DefaultValue("10000") int maxKeys, @DefaultValue("600") int addressLimit) {

            /** The default {@code address-limit}: the development throttle's {@code DEFAULT_ADDRESS_LIMIT}. */
            public static final int DEFAULT_ADDRESS_LIMIT = 600;

            public Throttle {
                window = window == null ? Duration.ofMinutes(1) : window;
                by = by == null ? List.of() : List.copyOf(by);
                limits = limits == null ? Map.of() : Map.copyOf(limits);
            }

            static Throttle defaults() {
                return new Throttle(true, 60, null, List.of("ip", "form"), null, 10_000, DEFAULT_ADDRESS_LIMIT);
            }
        }

        /**
         * {@code datum.web.openapi.*}.
         *
         * @param enabled     register Datum's springdoc groups when springdoc is on the classpath
         * @param groupPrefix prefix of the group names ({@code datum-forms}, {@code datum-submissions}, ...)
         */
        public record Openapi(@DefaultValue("true") boolean enabled, @DefaultValue("datum-") String groupPrefix) {

            static Openapi defaults() {
                return new Openapi(true, "datum-");
            }
        }
    }
}
