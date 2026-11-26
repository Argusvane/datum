package com.argusvane.datum.tck;

import java.net.http.HttpRequest;
import java.util.EnumSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/**
 * The host under test: its base URL, the paths it was configured with (the defaults are the hosts' defaults), and
 * how a request is made as a visitor or as a signed-in person.
 *
 * @param baseUrl          {@code http://localhost:8080} (no trailing slash; a context path belongs here)
 * @param apiPath          {@code datum.web.api.path}, default {@code /api}
 * @param assetsPath       {@code datum.web.assets.path}, default {@code /datum/assets}
 * @param tsaPath          {@code datum.tsa.path}, default {@code /tsa}
 * @param webAuthnPath     {@code datum.webauthn.path}, default {@code /api/webauthn}
 * @param builderEnabled   whether the builder's files are served ({@code datum.builder.enabled})
 * @param pdfSigning       whether the server holds a signing key ({@code datum.pdf.signing.ssl-bundle})
 * @param signingForm      the form whose passkey signature is required of signed-in people (the passkeys contract)
 * @param buildForm        a form the builder contract may read and save as {@link Who#PERSON}
 * @param headers          headers sent with every request
 * @param capabilities     what {@link HostTck} runs; a test class declares its own by the interfaces it implements
 * @param decorator        adds what makes a request a person's (a session cookie, a CSRF token, credentials)
 * @param csrf             the cookie-token CSRF recipe ({@code cookie:XSRF-TOKEN:X-XSRF-TOKEN}), or null: the token cookie any earlier
 *                         reply set is echoed as the header on every write, one token per {@link Who}
 * @param pdfBindings      whether the host routes the two fixture forms ({@link TckFixtures#FORM}, {@link TckFixtures#FORM_B}) to
 *                         bindings with different PDF themes ({@code datum.bindings.*}) and has both installed: the per-route case
 */
public record HostTarget(String baseUrl, String apiPath, String assetsPath, String tsaPath, String webAuthnPath,
                         boolean builderEnabled, boolean pdfSigning, String signingForm, String buildForm,
                         Map<String, String> headers, Set<Capability> capabilities, RequestDecorator decorator, Csrf csrf,
                         boolean pdfBindings) {

    /**
     * The cookie-token CSRF recipe, as the Node kit's {@code --csrf}: the token is the cookie the host sets (any reply, or a
     * {@code GET} of the base URL when none was seen yet), kept per {@link Who} as a browser keeps a jar per person, and sent back
     * as the header on a write (and as the cookie on every request once held). Mutable on purpose: it is the jar of one run.
     */
    public static final class Csrf {

        private final String cookie;
        private final String header;
        private final Map<Who, String> tokens = new java.util.concurrent.ConcurrentHashMap<>();

        public Csrf(String cookie, String header) {
            this.cookie = Objects.requireNonNull(cookie, "cookie");
            this.header = Objects.requireNonNull(header, "header");
        }

        /**
         * Reads {@code cookie:<cookie-name>:<header-name>}.
         *
         * @throws IllegalArgumentException for anything else, as the Node kit's usage error
         */
        public static Csrf parse(String value) {
            java.util.regex.Matcher match = RECIPE.matcher(value == null ? "" : value.strip());
            if (!match.matches()) {
                throw new IllegalArgumentException("datum.tck.csrf takes cookie:<cookie-name>:<header-name> (e.g. cookie:XSRF-TOKEN:X-XSRF-TOKEN), not \""
                    + value + "\"");
            }
            return new Csrf(match.group(1), match.group(2));
        }

        private static final java.util.regex.Pattern RECIPE = java.util.regex.Pattern.compile(
            "^cookie:([!#$%&'*+.^_`|~0-9A-Za-z-]+):([!#$%&'*+.^_`|~0-9A-Za-z-]+)$");

        /** The token cookie's name. */
        public String cookie() {
            return cookie;
        }

        /** The header a write carries the token in. */
        public String header() {
            return header;
        }

        /** The token {@code who} holds, or null. */
        public String token(Who who) {
            return tokens.get(who);
        }

        /** Reads the {@code Set-Cookie} lines of a reply for {@code who}: the token cookie is kept, or dropped when the host expires it. */
        public void take(Who who, java.util.List<String> setCookies) {
            for (String line : setCookies) {
                String[] parts = line.split(";");
                int equals = parts[0].indexOf('=');
                if (equals <= 0 || !parts[0].substring(0, equals).strip().equals(cookie)) {
                    continue;
                }
                boolean expired = false;
                for (int i = 1; i < parts.length; i++) {
                    String attribute = parts[i].strip();
                    int eq = attribute.indexOf('=');
                    String key = (eq < 0 ? attribute : attribute.substring(0, eq)).strip().toLowerCase(java.util.Locale.ROOT);
                    String attributeValue = eq < 0 ? "" : attribute.substring(eq + 1).strip();
                    if (key.equals("max-age") && attributeValue.matches("-?\\d+") && Long.parseLong(attributeValue) <= 0) {
                        expired = true;
                    }
                }
                if (expired) {
                    tokens.remove(who);
                } else {
                    tokens.put(who, parts[0].substring(equals + 1).strip());
                }
            }
        }
    }

    /** Who sends a request. */
    public enum Who {
        /** Nobody signed in. */
        VISITOR,
        /** A signed-in person (who may build, for the builder contract). */
        PERSON,
        /** Another signed-in person (who may not build). */
        OTHER_PERSON
    }

    /** Makes a request someone's: called for every request after the method, URL, body and {@link #headers} are set. */
    @FunctionalInterface
    public interface RequestDecorator {

        /** Nothing added: every request is a visitor's. */
        RequestDecorator NONE = (request, method, who) -> { };

        void decorate(HttpRequest.Builder request, String method, Who who);
    }

    public HostTarget {
        Objects.requireNonNull(baseUrl, "baseUrl");
        baseUrl = baseUrl.endsWith("/") ? baseUrl.substring(0, baseUrl.length() - 1) : baseUrl;
        headers = Map.copyOf(headers);
        capabilities = capabilities.isEmpty() ? Set.of() : Set.copyOf(EnumSet.copyOf(capabilities));
        decorator = decorator == null ? RequestDecorator.NONE : decorator;
    }

    /** As before the CSRF recipe: none. */
    public HostTarget(String baseUrl, String apiPath, String assetsPath, String tsaPath, String webAuthnPath,
                      boolean builderEnabled, boolean pdfSigning, String signingForm, String buildForm,
                      Map<String, String> headers, Set<Capability> capabilities, RequestDecorator decorator) {
        this(baseUrl, apiPath, assetsPath, tsaPath, webAuthnPath, builderEnabled, pdfSigning, signingForm, buildForm, headers, capabilities,
            decorator, null, false);
    }

    /** A host at {@code baseUrl} with every default path and nothing else declared. */
    public static HostTarget of(String baseUrl) {
        return builder(baseUrl).build();
    }

    /** {@code http://localhost:<port>}: a test server on a random port. */
    public static HostTarget local(int port) {
        return of("http://localhost:" + port);
    }

    public static Builder builder(String baseUrl) {
        return new Builder(baseUrl);
    }

    public Builder toBuilder() {
        Builder builder = new Builder(baseUrl);
        builder.apiPath = apiPath;
        builder.assetsPath = assetsPath;
        builder.tsaPath = tsaPath;
        builder.webAuthnPath = webAuthnPath;
        builder.builderEnabled = builderEnabled;
        builder.pdfSigning = pdfSigning;
        builder.signingForm = signingForm;
        builder.buildForm = buildForm;
        builder.headers.putAll(headers);
        builder.capabilities.addAll(capabilities);
        builder.decorator = decorator;
        builder.csrf = csrf;
        builder.pdfBindings = pdfBindings;
        return builder;
    }

    /** {@code baseUrl + apiPath + path}. */
    public String api(String path) {
        return baseUrl + apiPath + path;
    }

    /** The settings of a target; every member has the hosts' default. */
    public static final class Builder {

        private final String baseUrl;
        private String apiPath = "/api";
        private String assetsPath = "/datum/assets";
        private String tsaPath = "/tsa";
        private String webAuthnPath = "/api/webauthn";
        private boolean builderEnabled;
        private boolean pdfSigning;
        private String signingForm;
        private String buildForm;
        private final Map<String, String> headers = new LinkedHashMap<>();
        private final Set<Capability> capabilities = EnumSet.noneOf(Capability.class);
        private RequestDecorator decorator = RequestDecorator.NONE;
        private Csrf csrf;
        private boolean pdfBindings;

        private Builder(String baseUrl) {
            this.baseUrl = baseUrl;
        }

        public Builder apiPath(String apiPath) {
            this.apiPath = apiPath;
            return this;
        }

        public Builder assetsPath(String assetsPath) {
            this.assetsPath = assetsPath;
            return this;
        }

        public Builder tsaPath(String tsaPath) {
            this.tsaPath = tsaPath;
            return this;
        }

        public Builder webAuthnPath(String webAuthnPath) {
            this.webAuthnPath = webAuthnPath;
            return this;
        }

        public Builder builderEnabled(boolean builderEnabled) {
            this.builderEnabled = builderEnabled;
            return this;
        }

        public Builder pdfSigning(boolean pdfSigning) {
            this.pdfSigning = pdfSigning;
            return this;
        }

        public Builder signingForm(String signingForm) {
            this.signingForm = signingForm;
            return this;
        }

        public Builder buildForm(String buildForm) {
            this.buildForm = buildForm;
            return this;
        }

        public Builder header(String name, String value) {
            headers.put(name, value);
            return this;
        }

        public Builder capabilities(Set<Capability> capabilities) {
            this.capabilities.addAll(capabilities);
            return this;
        }

        public Builder decorator(RequestDecorator decorator) {
            this.decorator = decorator;
            return this;
        }

        /** The cookie-token CSRF recipe the requests follow (see {@link Csrf}); null for none. */
        public Builder csrf(Csrf csrf) {
            this.csrf = csrf;
            return this;
        }

        /** Whether the host routes the two fixture forms to bindings with different PDF themes (the per-route case). */
        public Builder pdfBindings(boolean pdfBindings) {
            this.pdfBindings = pdfBindings;
            return this;
        }

        public HostTarget build() {
            return new HostTarget(baseUrl, apiPath, assetsPath, tsaPath, webAuthnPath, builderEnabled, pdfSigning, signingForm, buildForm,
                headers, capabilities, decorator, csrf, pdfBindings);
        }
    }
}
