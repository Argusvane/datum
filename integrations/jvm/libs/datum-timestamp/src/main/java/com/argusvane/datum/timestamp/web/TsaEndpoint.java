package com.argusvane.datum.timestamp.web;

import com.argusvane.datum.core.CountedAddress;
import com.argusvane.datum.core.DatumEventPublisher;
import com.argusvane.datum.timestamp.TimestampAuthority;
import com.argusvane.datum.timestamp.TimestampReply;
import com.argusvane.datum.timestamp.TsaClient;
import com.argusvane.datum.timestamp.TsaClientKeys;
import com.argusvane.datum.timestamp.TsaClientStore;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.stream.Collectors;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The timestamp server's request handling, once, for both web stacks (endpoint catalog {@code issueTimestamp}). The
 * MVC controller and the WebFlux handlers read their
 * request into a {@link TsaRequest}, call {@link #admit}, read the body (bounded by {@link #maxBody()}) and call
 * {@link #issue}; every decision is here, so the stacks cannot drift apart.
 *
 * <p>The checks run in this order, which the host kit's TSA cases hold ("403 for a session cookie then 415"). A
 * request carrying a browser session cookie is refused first (403: the server takes no session and a client key never
 * rides on one). By default that is any cookie at all ({@code "*"} in {@link TsaSettings#sessionCookies()}); a configured
 * list of names refuses only requests that carry one of those names, compared without regard to case;
 * then 415 for another content type; then, when the server is for clients only or the request carries
 * credentials, a client key: ten failed keys per address per hour then 429 (an IPv6 client counted by its /64), a missing or wrong key 401 with the
 * {@code WWW-Authenticate} challenge; then the flood limit (per client, or per address for open requests) 429
 * with {@code Retry-After}; then 413 for a body larger than the limit. What follows is a TimeStampResp:
 * 200 with a token, 400 when the request is refused, 503 when the server cannot issue one.
 *
 * <p>A request refused before the body is read does not read it, so a flood or a wrong key costs no bytes.
 */
public final class TsaEndpoint {

    private static final Logger LOG = LoggerFactory.getLogger(TsaEndpoint.class);

    /** The session cookie name that stands for every cookie. */
    static final String ANY_COOKIE = "*";

    private static final String FAILED_KEYS = TsaFlood.KEY_EVENT + "_failed";
    private static final Set<String> QUERY_TYPES = Set.of("application/timestamp-query", "application/timestamp-request");

    /** The answer to {@link #admit}: a client (or none, for an open request) to go on with, or a refusal to send. */
    public record Admission(TsaClient client, TsaHttpReply refusal) {

        public boolean admitted() {
            return refusal == null;
        }
    }

    private final TimestampAuthority authority;
    private final TsaClientStore clients;
    private final TsaFlood flood;
    private final TsaCertificates certificates;
    private final TsaSettings.Access access;
    private final int floodLimit;
    private final int failedKeysPerHour;
    private final long floodWindowSeconds;
    private final long maxBody;
    private final Set<String> sessionCookies;
    private final boolean anyCookieRefused;
    private final DatumEventPublisher events;

    public TsaEndpoint(TimestampAuthority authority, TsaClientStore clients, TsaFlood flood, TsaCertificates certificates,
                       TsaSettings settings, DatumEventPublisher events) {
        this(authority, clients, flood, certificates, settings, events, Set.of());
    }

    /** As above, refusing also the session cookie names in {@code extraSessionCookies} (the host's renamed cookie). */
    public TsaEndpoint(TimestampAuthority authority, TsaClientStore clients, TsaFlood flood, TsaCertificates certificates,
                       TsaSettings settings, DatumEventPublisher events, Set<String> extraSessionCookies) {
        this.authority = Objects.requireNonNull(authority, "authority");
        this.clients = Objects.requireNonNull(clients, "clients");
        this.flood = Objects.requireNonNull(flood, "flood");
        this.certificates = Objects.requireNonNull(certificates, "certificates");
        this.access = settings.access();
        this.floodLimit = settings.floodLimit();
        this.failedKeysPerHour = settings.failedKeysPerHour();
        this.floodWindowSeconds = settings.floodWindow().toSeconds();
        this.maxBody = settings.maxRequestBytes();
        this.sessionCookies = java.util.stream.Stream.concat(settings.sessionCookies().stream(), extraSessionCookies.stream())
            .map(name -> name.strip().toLowerCase(Locale.ROOT)).collect(Collectors.toSet());
        // "*" anywhere in the list means any cookie, as the FastAPI host reads datum.tsa.session_cookies; the host's own
        // renamed session cookie (extraSessionCookies) is then already covered, so it is redundant but harmless.
        this.anyCookieRefused = sessionCookies.contains(ANY_COOKIE);
        // As given: through the host's guarded default a listener never turns a signed token into a 500; an
        // application's own publisher owns its failures, and one that throws reaches the caller.
        this.events = Objects.requireNonNull(events, "events");
    }

    /** The largest request body read, in bytes. */
    public long maxBody() {
        return maxBody;
    }

    /** The authority behind the endpoint. */
    public TimestampAuthority authority() {
        return authority;
    }

    /** Everything that is decided before the body is read. */
    public Admission admit(TsaRequest request) {
        boolean refusedCookie = anyCookieRefused
            ? !request.cookieNames().isEmpty()
            : request.cookieNames().stream().anyMatch(name -> sessionCookies.contains(name.toLowerCase(Locale.ROOT)));
        if (refusedCookie) {
            return refuse(TsaHttpReply.plain(403,
                "This timestamp server takes no browser session: send the request without cookies (and with a client key, if the server asks for one)."));
        }
        if (!QUERY_TYPES.contains(mediaType(request.contentType()))) {
            return refuse(TsaHttpReply.plain(415, "Send a TimeStampReq as application/timestamp-query."));
        }
        // Both counters key an address as CountedAddress gives it: an IPv6 client by its /64, which one host commonly holds whole.
        String address = CountedAddress.of(request.remote());
        TsaClient client = null;
        boolean credentials = TsaClientKeys.hasCredentials(request.authorization());
        if (credentials || access == TsaSettings.Access.CLIENTS) {
            if (!flood.isAllowed(FAILED_KEYS, failedKeysPerHour, 3600, address)) {
                return refuse(TsaHttpReply.plain(429, "Too many requests with a wrong key from this address. Try again later.",
                    Map.of("Retry-After", "3600")));
            }
            String key = TsaClientKeys.keyOf(request.authorization());
            client = key == null ? null : clients.authenticate(key).orElse(null);
            if (client == null) {
                if (credentials) {
                    flood.register(FAILED_KEYS, 3600, address);
                }
                return refuse(TsaHttpReply.plain(401,
                    "This timestamp server needs a client key: send it as a bearer token, or as the password of HTTP Basic authentication.",
                    Map.of("WWW-Authenticate", "Bearer realm=\"timestamp server\", Basic realm=\"timestamp server\"")));
            }
        }
        if (floodLimit > 0) {
            String event = client == null ? TsaFlood.OPEN_EVENT : TsaFlood.CLIENT_EVENT;
            String identifier = client == null ? address : "client:" + client.id();
            if (!flood.acquire(event, floodLimit, floodWindowSeconds, identifier)) {
                return refuse(TsaHttpReply.plain(429, "Too many timestamp requests. Try again later.",
                    Map.of("Retry-After", String.valueOf(floodWindowSeconds))));
            }
        }
        if (request.declaredLength() > maxBody) {
            return refuse(tooLarge());
        }
        return new Admission(client, null);
    }

    /** The 413 answer, for an adapter whose body read went over the limit. */
    public TsaHttpReply tooLarge() {
        return TsaHttpReply.plain(413, "A TimeStampReq is a few hundred bytes; this request is too large.");
    }

    /**
     * Answers an admitted request: the TimeStampResp for {@code body}, publishing the issued or refused event.
     *
     * @param body the request body, read with at most {@link #maxBody()} + 1 bytes
     * @param client the client {@link #admit} found, or {@code null}
     */
    public TsaHttpReply issue(byte[] body, TsaClient client) {
        if (body.length > maxBody) {
            return tooLarge();
        }
        TimestampReply answer = authority.respond(body, client == null ? null : client.id());
        TsaHttpReply reply = new TsaHttpReply(answer.status(), "application/timestamp-reply", Map.of("Cache-Control", "no-store"), answer.body());
        // The token is signed and its serial spent: a failing usage count or event listener must not turn that into
        // a 500 with no token (use is counted after the response is built). A listener's failure is the host's guarded
        // default publisher's to log; the count's is logged here, and, as before, a token whose use could not be
        // counted is not announced either.
        if (answer.granted()) {
            if (client != null) {
                try {
                    clients.used(client);
                } catch (RuntimeException e) {
                    LOG.warn("The timestamp answer was sent, but counting it failed: {}", e.toString());
                    return reply;
                }
            }
            events.publish(new TimestampIssuedEvent(answer.issued().serial(), answer.issued().genTime(), answer.issued().algorithm(),
                client == null ? null : client.id()));
        } else {
            events.publish(new TimestampRefusedEvent(answer.refusal().failInfo(), answer.refusal().message()));
        }
        return reply;
    }

    /** {@code GET /tsa/certificate}. */
    public TsaHttpReply certificate(String format) {
        return certificates.certificate("der".equals(format));
    }

    /** {@code GET /tsa/certificates}. */
    public TsaHttpReply certificates() {
        return certificates.certificates();
    }

    private static Admission refuse(TsaHttpReply reply) {
        return new Admission(null, reply);
    }

    private static String mediaType(String contentType) {
        if (contentType == null) {
            return "";
        }
        int semicolon = contentType.indexOf(';');
        return (semicolon < 0 ? contentType : contentType.substring(0, semicolon)).strip().toLowerCase(Locale.ROOT);
    }
}
