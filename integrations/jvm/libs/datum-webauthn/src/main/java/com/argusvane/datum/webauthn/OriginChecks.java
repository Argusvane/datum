package com.argusvane.datum.webauthn;

import com.webauthn4j.data.client.Origin;
import com.argusvane.datum.core.DatumConfigurationException;
import java.net.URI;
import java.net.URISyntaxException;
import java.util.List;
import java.util.Locale;

/**
 * Validates {@code datum.webauthn.rp-id} and {@code datum.webauthn.origins} at start. An origin webauthn4j cannot
 * parse makes every WebAuthn gate fail as {@code malformed}, which looks like a broken authenticator; a
 * relying-party id the origins are not under fails every ceremony in the browser. Both are configuration
 * mistakes, so the start fails and names the property.
 */
final class OriginChecks {

    private OriginChecks() {
    }

    /**
     * @throws IllegalStateException naming the property and the value when one is not usable
     */
    static void validate(String rpId, List<String> origins) {
        String id = rpId == null ? "" : rpId.strip().toLowerCase(Locale.ROOT);
        for (String raw : origins) {
            String origin = raw == null ? "" : raw.strip();
            while (origin.endsWith("/")) {
                origin = origin.substring(0, origin.length() - 1);
            }
            if (origin.isEmpty()) {
                continue;
            }
            URI uri;
            try {
                uri = new URI(origin);
            } catch (URISyntaxException e) {
                throw bad(raw, "it is not a URI");
            }
            String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
            if (!scheme.equals("https") && !scheme.equals("http")) {
                throw bad(raw, "an origin is https://host[:port] (http only for localhost)");
            }
            if (uri.getHost() == null || uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null
                || (uri.getPath() != null && !uri.getPath().isEmpty())) {
                throw bad(raw, "an origin is a scheme, a host and an optional port, with no path, query or user");
            }
            String host = uri.getHost().toLowerCase(Locale.ROOT);
            if (scheme.equals("http") && !host.equals("localhost") && !host.endsWith(".localhost")) {
                throw bad(raw, "browsers allow passkeys only over https (or http on localhost)");
            }
            // The verifier compares the client's origin exactly, and a browser serialises it lower-case, without
            // the scheme's default port and without a trailing dot. An origin written any other way passes every
            // start check and then fails every ceremony as if the authenticator were broken.
            String canonical = scheme + "://" + host + (uri.getPort() == -1 || uri.getPort() == defaultPort(scheme) ? "" : ":" + uri.getPort());
            if (host.endsWith(".")) {
                throw bad(raw, "write the host without a trailing dot, as the browser sends it");
            }
            if (!origin.equals(canonical)) {
                throw bad(raw, "write it the way a browser sends it: lower-case scheme and host, no default port (" + canonical + ")");
            }
            try {
                new Origin(origin);
            } catch (RuntimeException e) {
                throw bad(raw, "the WebAuthn library cannot read it");
            }
            if (!id.isEmpty() && !host.equals(id) && !host.endsWith("." + id)) {
                throw new DatumConfigurationException("datum.webauthn.origins", "datum.webauthn.origins has " + raw + ", which is not under datum.webauthn.rp-id " + rpId
                    + ": the relying-party id must be the origin's host or a parent domain of it.");
            }
        }
    }

    private static int defaultPort(String scheme) {
        return scheme.equals("https") ? 443 : 80;
    }

    private static IllegalStateException bad(String origin, String why) {
        return new IllegalStateException("datum.webauthn.origins has \"" + origin + "\", which cannot be used: " + why + ".");
    }
}
