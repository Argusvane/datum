package com.argusvane.datum.tck;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Map;

/**
 * Requests to the host under test. Redirects are never followed (a contract asserts the first answer); every
 * request carries the target's headers and goes through its {@link HostTarget.RequestDecorator}.
 */
public final class HostHttp {

    private static final HttpClient CLIENT = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER)
        .connectTimeout(Duration.ofSeconds(20)).build();

    private static final java.util.Set<String> WRITES = java.util.Set.of("POST", "PUT", "PATCH", "DELETE");

    private final HostTarget target;

    public HostHttp(HostTarget target) {
        this.target = target;
    }

    public HostTarget target() {
        return target;
    }

    /** A GET of {@code url} (absolute, or a path under the base URL) as a visitor. */
    public Reply get(String url) {
        return send("GET", url, null, null, HostTarget.Who.VISITOR, Map.of());
    }

    public Reply get(String url, HostTarget.Who who, Map<String, String> headers) {
        return send("GET", url, null, null, who, headers);
    }

    /** A POST of a JSON text as a visitor. */
    public Reply postJson(String url, String json) {
        return send("POST", url, "application/json", json.getBytes(StandardCharsets.UTF_8), HostTarget.Who.VISITOR, Map.of());
    }

    /** A POST of bytes with a content type (null: none) as a visitor. */
    public Reply post(String url, String contentType, byte[] body) {
        return send("POST", url, contentType, body, HostTarget.Who.VISITOR, Map.of());
    }

    /**
     * Any request.
     *
     * @param method      GET, POST, PUT, DELETE, HEAD
     * @param url         absolute, or a path under the base URL
     * @param contentType the body's type, or null for none
     * @param body        the body, or null for none
     * @param who         who sends it
     * @param headers     more headers for this request
     */
    public Reply send(String method, String url, String contentType, byte[] body, HostTarget.Who who, Map<String, String> headers) {
        URI uri = URI.create(url.startsWith("http://") || url.startsWith("https://") ? url : target.baseUrl() + url);
        HttpRequest.Builder request = HttpRequest.newBuilder(uri).timeout(Duration.ofSeconds(120))
            .method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofByteArray(body));
        if (contentType != null) {
            request.header("Content-Type", contentType);
        }
        target.headers().forEach(request::header);
        headers.forEach(request::header);
        target.decorator().decorate(request, method, who);
        HostTarget.Csrf csrf = target.csrf();
        if (csrf != null) {
            // The recipe (datum.tck.csrf): a write carries the header, and once the person holds the token cookie every request
            // carries it, from the persona's reply jar and nothing else (the Node kit sends only that cookie from its jar).
            String token = csrf.token(who);
            if (token == null && WRITES.contains(method.toUpperCase(java.util.Locale.ROOT))) {
                send("GET", target.baseUrl() + "/", null, null, who, Map.of());
                token = csrf.token(who);
                if (token == null) {
                    throw new AssertionError("no " + csrf.cookie() + " cookie on GET " + target.baseUrl() + "/ (as " + who.name().toLowerCase(java.util.Locale.ROOT)
                        + "): the host hands out no CSRF token the datum.tck.csrf recipe can echo");
                }
            }
            if (token != null) {
                if (WRITES.contains(method.toUpperCase(java.util.Locale.ROOT))) {
                    request.header(csrf.header(), token);
                }
                request.header("Cookie", csrf.cookie() + "=" + token);
            }
        }
        try {
            HttpResponse<byte[]> response = CLIENT.send(request.build(), HttpResponse.BodyHandlers.ofByteArray());
            if (csrf != null) {
                csrf.take(who, response.headers().allValues("Set-Cookie"));
            }
            return new Reply(response.statusCode(), response.headers(), response.body());
        } catch (IOException e) {
            throw new UncheckedIOException(method + " " + uri + " failed", e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Interrupted: " + method + " " + uri, e);
        }
    }
}
