package com.argusvane.datum.web;

import com.argusvane.datum.core.DatumConfigurationException;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * The root {@code datum.*} settings, {@code datum.enabled} and {@code datum.web.*}, as one framework-free value
 * with its defaults and normalisation. Spring's {@code DatumProperties} and a Quarkus config mapping would also map onto it, so a path is normalised
 * and an endpoint's default switch decided in one place.
 *
 * @param enabled  {@code datum.enabled}: with false no Datum capability applies
 * @param api      {@code datum.web.api.*}
 * @param assets   {@code datum.web.assets.*}
 * @param csrf     {@code datum.web.csrf.*}: the names the page glue reads (the token itself is the framework's)
 * @param throttle {@code datum.web.throttle.*}: read by the submissions module, which does the throttling
 * @param openapi  {@code datum.web.openapi.*}
 */
public record WebSettings(boolean enabled, Api api, Assets assets, Csrf csrf, Throttle throttle, OpenApi openapi) {
    // Copies: one component changed, the rest kept; the canonical constructor
    // checks the result, so a copy cannot hold what a new value could not. Replaces a positional constructor call that
    // breaks whenever a component is added.

    /** A copy with {@code enabled} replaced and every other component kept. */
    public WebSettings withEnabled(boolean value) {
        return new WebSettings(value, api, assets, csrf, throttle, openapi);
    }

    /** A copy with {@code api} replaced and every other component kept. */
    public WebSettings withApi(Api value) {
        return new WebSettings(enabled, value, assets, csrf, throttle, openapi);
    }

    /** A copy with {@code assets} replaced and every other component kept. */
    public WebSettings withAssets(Assets value) {
        return new WebSettings(enabled, api, value, csrf, throttle, openapi);
    }

    /** A copy with {@code csrf} replaced and every other component kept. */
    public WebSettings withCsrf(Csrf value) {
        return new WebSettings(enabled, api, assets, value, throttle, openapi);
    }

    /** A copy with {@code throttle} replaced and every other component kept. */
    public WebSettings withThrottle(Throttle value) {
        return new WebSettings(enabled, api, assets, csrf, value, openapi);
    }

    /** A copy with {@code openapi} replaced and every other component kept. */
    public WebSettings withOpenapi(OpenApi value) {
        return new WebSettings(enabled, api, assets, csrf, throttle, value);
    }

    public WebSettings {
        api = api == null ? Api.defaults() : api;
        assets = assets == null ? Assets.defaults() : assets;
        csrf = csrf == null ? Csrf.defaults() : csrf;
        throttle = throttle == null ? Throttle.defaults() : throttle;
        openapi = openapi == null ? OpenApi.defaults() : openapi;
    }

    /** What an application that set nothing runs with. */
    public static WebSettings defaults() {
        return new WebSettings(true, Api.defaults(), Assets.defaults(), Csrf.defaults(), Throttle.defaults(), OpenApi.defaults());
    }

    /**
     * {@code datum.web.api.*}.
     *
     * @param path           where the JSON endpoints live: one leading slash, no trailing slash ({@code /api})
     * @param maxBodyBytes   the largest request body a JSON endpoint reads, counted on the raw stream before parsing
     * @param problemDetails answer errors as RFC 9457 problem details with the same codes
     * @param endpoints      per-endpoint switches ({@code submissions}, {@code validate}, {@code definition}, ...); a name that is not set is off
     * @param busyRetryAfter the {@code Retry-After} a {@code server.busy} 503 carries (whole seconds, 1 s to 1 h; null: 5 s)
     */
    public record Api(String path, long maxBodyBytes, boolean problemDetails, Map<String, Boolean> endpoints, Duration busyRetryAfter) {
    // Copies: one component changed, the rest kept; the canonical constructor
    // checks the result, so a copy cannot hold what a new value could not. Replaces a positional constructor call that
    // breaks whenever a component is added.

    /** A copy with {@code path} replaced and every other component kept. */
    public Api withPath(String value) {
        return new Api(value, maxBodyBytes, problemDetails, endpoints, busyRetryAfter);
    }

    /** A copy with {@code maxBodyBytes} replaced and every other component kept. */
    public Api withMaxBodyBytes(long value) {
        return new Api(path, value, problemDetails, endpoints, busyRetryAfter);
    }

    /** A copy with {@code problemDetails} replaced and every other component kept. */
    public Api withProblemDetails(boolean value) {
        return new Api(path, maxBodyBytes, value, endpoints, busyRetryAfter);
    }

    /** A copy with {@code endpoints} replaced and every other component kept. */
    public Api withEndpoints(Map<String, Boolean> value) {
        return new Api(path, maxBodyBytes, problemDetails, value, busyRetryAfter);
    }

    /** A copy with {@code busyRetryAfter} replaced and every other component kept. */
    public Api withBusyRetryAfter(Duration value) {
        return new Api(path, maxBodyBytes, problemDetails, endpoints, value);
    }

        /** {@code /api}. */
        public static final String DEFAULT_PATH = "/api";

        /**
         * The property prefix of the per-endpoint switches ({@code datum.web.api.endpoints.submissions}). A binding's
         * {@code @ConditionalOnBooleanProperty} names a switch as this prefix plus the endpoint name, so the property
         * path is written once, here, and no binding class carries a dotted string.
         */
        public static final String SWITCH_PREFIX = "datum.web.api.endpoints.";

        /** One mebibyte. */
        public static final long DEFAULT_MAX_BODY_BYTES = 1_048_576L;

        /** The {@code Retry-After} of a busy answer: five seconds, as the slot wait is a couple of seconds. */
        public static final Duration DEFAULT_BUSY_RETRY_AFTER = Duration.ofSeconds(5);

        /** The longest {@code Retry-After} a busy answer may carry. */
        public static final Duration MAX_BUSY_RETRY_AFTER = Duration.ofHours(1);

        /** A host built without the retry setting: the default. */
        public Api(String path, long maxBodyBytes, boolean problemDetails, Map<String, Boolean> endpoints) {
            this(path, maxBodyBytes, problemDetails, endpoints, null);
        }

        /** @throws IllegalArgumentException for a body cap below one byte (the start fails, naming the property) */
        public Api {
            if (maxBodyBytes < 1) {
                throw new DatumConfigurationException("datum.web.api.max-body-size", "datum.web.api.max-body-size is " + maxBodyBytes + "B; it must be at least 1B.");
            }
            path = normalise(path, DEFAULT_PATH);
            endpoints = endpoints == null ? Map.of() : java.util.Collections.unmodifiableMap(new LinkedHashMap<>(endpoints));
            busyRetryAfter = busyRetryAfter == null ? DEFAULT_BUSY_RETRY_AFTER : busyRetryAfter;
            if (busyRetryAfter.toNanosPart() != 0 || busyRetryAfter.compareTo(Duration.ofSeconds(1)) < 0
                || busyRetryAfter.compareTo(MAX_BUSY_RETRY_AFTER) > 0) {
                // A header of whole seconds: a fraction or a value outside 1 s to 1 h is a typo, not something to round quietly.
                throw new DatumConfigurationException("datum.web.api.busy-retry-after", "datum.web.api.busy-retry-after is " + busyRetryAfter
                    + "; it must be whole seconds from 1 s to 1 h.");
            }
        }

        public static Api defaults() {
            return new Api(DEFAULT_PATH, DEFAULT_MAX_BODY_BYTES, false, Map.of(), DEFAULT_BUSY_RETRY_AFTER);
        }

        /**
         * Whether an endpoint is on: only when the application switched it on. Every endpoint is off by default
         * (framework-first: a starter on the classpath registers no route until it is told to).
         */
        public boolean endpointEnabled(String name) {
            return Boolean.TRUE.equals(endpoints.get(name));
        }
    }

    /**
     * {@code datum.web.assets.*}.
     *
     * @param enabled      serve the bundles from the classpath under the versioned path (off by default: the asset routes are endpoints)
     * @param path         where the assets are served, one leading slash, no trailing slash ({@code /datum/assets})
     * @param cachePeriod  the max-age of the immutable asset answers
     * @param omitFeatures feature tokens whose files answer 404, added to what the build left out
     */
    public record Assets(boolean enabled, String path, Duration cachePeriod, List<String> omitFeatures) {
    // Copies: one component changed, the rest kept; the canonical constructor
    // checks the result, so a copy cannot hold what a new value could not. Replaces a positional constructor call that
    // breaks whenever a component is added.

    /** A copy with {@code enabled} replaced and every other component kept. */
    public Assets withEnabled(boolean value) {
        return new Assets(value, path, cachePeriod, omitFeatures);
    }

    /** A copy with {@code path} replaced and every other component kept. */
    public Assets withPath(String value) {
        return new Assets(enabled, value, cachePeriod, omitFeatures);
    }

    /** A copy with {@code cachePeriod} replaced and every other component kept. */
    public Assets withCachePeriod(Duration value) {
        return new Assets(enabled, path, value, omitFeatures);
    }

    /** A copy with {@code omitFeatures} replaced and every other component kept. */
    public Assets withOmitFeatures(List<String> value) {
        return new Assets(enabled, path, cachePeriod, value);
    }

        public static final String DEFAULT_PATH = "/datum/assets";

        public static final Duration DEFAULT_CACHE_PERIOD = Duration.ofDays(365);

        /** @throws IllegalArgumentException for a negative cache period (the start fails, naming the property) */
        public Assets {
            path = normalise(path, DEFAULT_PATH);
            cachePeriod = cachePeriod == null ? DEFAULT_CACHE_PERIOD : cachePeriod;
            if (cachePeriod.isNegative()) {
                throw new DatumConfigurationException("datum.web.assets.cache-period", "datum.web.assets.cache-period is " + cachePeriod + "; it must not be negative.");
            }
            omitFeatures = omitFeatures == null ? List.of() : List.copyOf(omitFeatures);
        }

        public static Assets defaults() {
            return new Assets(false, DEFAULT_PATH, DEFAULT_CACHE_PERIOD, List.of());
        }
    }

    /** {@code datum.web.csrf.*}: the header, cookie and meta names the page glue reads. */
    public record Csrf(String headerName, String cookieName, String metaName) {
    // Copies: one component changed, the rest kept; the canonical constructor
    // checks the result, so a copy cannot hold what a new value could not. Replaces a positional constructor call that
    // breaks whenever a component is added.

    /** A copy with {@code headerName} replaced and every other component kept. */
    public Csrf withHeaderName(String value) {
        return new Csrf(value, cookieName, metaName);
    }

    /** A copy with {@code cookieName} replaced and every other component kept. */
    public Csrf withCookieName(String value) {
        return new Csrf(headerName, value, metaName);
    }

    /** A copy with {@code metaName} replaced and every other component kept. */
    public Csrf withMetaName(String value) {
        return new Csrf(headerName, cookieName, value);
    }

        public static final String DEFAULT_HEADER = "X-XSRF-TOKEN";
        public static final String DEFAULT_COOKIE = "XSRF-TOKEN";
        public static final String DEFAULT_META = "_csrf";

        public static Csrf defaults() {
            return new Csrf(DEFAULT_HEADER, DEFAULT_COOKIE, DEFAULT_META);
        }
    }

    /**
     * {@code datum.web.throttle.*}, as configured: the submissions module checks it when it builds the throttle (a
     * limit below 1, a window that is not positive and an unknown {@code by} word each stop the start there).
     */
    public record Throttle(boolean enabled, int limit, Duration window, List<String> by) {
    // Copies: one component changed, the rest kept; the canonical constructor
    // checks the result, so a copy cannot hold what a new value could not. Replaces a positional constructor call that
    // breaks whenever a component is added.

    /** A copy with {@code enabled} replaced and every other component kept. */
    public Throttle withEnabled(boolean value) {
        return new Throttle(value, limit, window, by);
    }

    /** A copy with {@code limit} replaced and every other component kept. */
    public Throttle withLimit(int value) {
        return new Throttle(enabled, value, window, by);
    }

    /** A copy with {@code window} replaced and every other component kept. */
    public Throttle withWindow(Duration value) {
        return new Throttle(enabled, limit, value, by);
    }

    /** A copy with {@code by} replaced and every other component kept. */
    public Throttle withBy(List<String> value) {
        return new Throttle(enabled, limit, window, value);
    }

        public static final int DEFAULT_LIMIT = 60;
        public static final Duration DEFAULT_WINDOW = Duration.ofMinutes(1);
        public static final List<String> DEFAULT_BY = List.of("ip", "form");

        public Throttle {
            by = by == null ? List.of() : List.copyOf(by);
        }

        public static Throttle defaults() {
            return new Throttle(true, DEFAULT_LIMIT, DEFAULT_WINDOW, DEFAULT_BY);
        }
    }

    /** {@code datum.web.openapi.*}: whether Datum's OpenAPI groups exist, and the prefix of their names. */
    public record OpenApi(boolean enabled, String groupPrefix) {
    // Copies: one component changed, the rest kept; the canonical constructor
    // checks the result, so a copy cannot hold what a new value could not. Replaces a positional constructor call that
    // breaks whenever a component is added.

    /** A copy with {@code enabled} replaced and every other component kept. */
    public OpenApi withEnabled(boolean value) {
        return new OpenApi(value, groupPrefix);
    }

    /** A copy with {@code groupPrefix} replaced and every other component kept. */
    public OpenApi withGroupPrefix(String value) {
        return new OpenApi(enabled, value);
    }

        public static final String DEFAULT_GROUP_PREFIX = "datum-";

        public OpenApi {
            groupPrefix = Objects.requireNonNullElse(groupPrefix, DEFAULT_GROUP_PREFIX);
        }

        public static OpenApi defaults() {
            return new OpenApi(true, DEFAULT_GROUP_PREFIX);
        }
    }

    /** One leading slash, no trailing slash; blank falls back. */
    public static String normalise(String path, String fallback) {
        if (path == null || path.isBlank()) {
            return fallback;
        }
        String trimmed = path.strip();
        while (trimmed.length() > 1 && trimmed.endsWith("/")) {
            trimmed = trimmed.substring(0, trimmed.length() - 1);
        }
        return trimmed.startsWith("/") ? trimmed : "/" + trimmed;
    }
}
