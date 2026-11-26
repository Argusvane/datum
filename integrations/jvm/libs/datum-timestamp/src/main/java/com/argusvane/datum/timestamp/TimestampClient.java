package com.argusvane.datum.timestamp;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import org.bouncycastle.asn1.ASN1BitString;
import org.bouncycastle.asn1.cmp.PKIFreeText;
import org.bouncycastle.asn1.cmp.PKIStatusInfo;
import org.bouncycastle.asn1.tsp.TimeStampResp;

/**
 * Asks a named RFC 3161 timestamp server over HTTP (RFC 3161 section 3.4): the remote half of {@link Timestamper}.
 *
 * <p>Posts the TimeStampReq ({@code Content-Type: application/timestamp-query}, {@code Accept:
 * application/timestamp-reply}) through a {@link TsaTransport} and takes the reply only when the server answers 200
 * with a PKIStatus of granted (0) or granted with modifications (1); anything else is a
 * {@link TimestampClientException} whose message names the server and the problem. What the token holds is checked
 * by whoever reads it ({@link TimestampToken}).
 *
 * <p>The HTTP client is the transport's: the default {@link JdkTsaTransport} sends plain HTTP/1.1,
 * follows no redirect and bounds the whole exchange, headers and body, by the
 * timeout; a host supplies its own client through {@code JdkTsaTransport(HttpClient)} or its own transport (the Spring
 * binding's rides {@code RestClient.Builder}). Credentials, when the server asks for them: a bearer token or HTTP
 * Basic, sent only to the URL named.
 */
public final class TimestampClient implements Timestamper {

    /** The longest reply read: a TimeStampResp with a long chain is a few kilobytes. */
    public static final int MAX_REPLY_BYTES = TsaTransport.MAX_REPLY_BYTES;

    /** How the client authenticates to the server. */
    public sealed interface Credentials permits Bearer, Basic {

        /** The Authorization header value. */
        String header();
    }

    /** {@code Authorization: Bearer <token>}. */
    public record Bearer(String token) implements Credentials {
        public Bearer {
            Objects.requireNonNull(token, "token");
        }

        @Override
        public String header() {
            return "Bearer " + token;
        }

        @Override
        public String toString() {
            return "Bearer[***]";
        }
    }

    /** HTTP Basic: a user name and a password (a timestamp server's client key is often given as the password). */
    public record Basic(String user, String password) implements Credentials {
        public Basic {
            Objects.requireNonNull(user, "user");
            Objects.requireNonNull(password, "password");
        }

        @Override
        public String header() {
            return "Basic " + Base64.getEncoder().encodeToString((user + ":" + password).getBytes(StandardCharsets.UTF_8));
        }

        @Override
        public String toString() {
            return "Basic[" + user + ", ***]";
        }
    }

    private final URI url;
    private final Duration timeout;
    private final Credentials credentials;
    private final TsaTransport transport;
    private final String policy;

    /** A client with a 10-second timeout, no credentials and the default {@link JdkTsaTransport}. */
    public TimestampClient(URI url) {
        this(url, Duration.ofSeconds(10), null);
    }

    /**
     * A client on the default {@link JdkTsaTransport}.
     *
     * @param url the timestamp server: an absolute http or https URL with a host
     * @param timeout how long a whole request may take, a second at least ({@code null}: 10 seconds)
     * @param credentials how to authenticate, or {@code null}
     * @throws IllegalArgumentException when the URL is not one the client can post to
     */
    public TimestampClient(URI url, Duration timeout, Credentials credentials) {
        this(url, timeout, credentials, new JdkTsaTransport());
    }

    /**
     * @param url the timestamp server: an absolute http or https URL with a host
     * @param timeout how long a whole request may take, a second at least ({@code null}: 10 seconds)
     * @param credentials how to authenticate, or {@code null}
     * @param transport what carries the request: {@link JdkTsaTransport} over the host's own {@code HttpClient}, or a
     *     host's own
     * @throws IllegalArgumentException when the URL is not one the client can post to
     */
    public TimestampClient(URI url, Duration timeout, Credentials credentials, TsaTransport transport) {
        this(url, timeout, credentials, transport, null);
    }

    /**
     * @param policy the {@code reqPolicy} every request carries, dotted (a server that issues under several policies picks by
     *     it, and refuses another with unacceptedPolicy); {@code null} or blank asks for none, the server's own
     * @throws IllegalArgumentException when the URL is not one the client can post to or the policy is not an object identifier
     */
    public TimestampClient(URI url, Duration timeout, Credentials credentials, TsaTransport transport, String policy) {
        this.url = Objects.requireNonNull(url, "url");
        String scheme = url.getScheme() == null ? "" : url.getScheme().toLowerCase(Locale.ROOT);
        if (!(scheme.equals("http") || scheme.equals("https")) || url.getHost() == null || url.getHost().isEmpty()) {
            throw new IllegalArgumentException("The timestamp server URL " + url + " is not an http or https URL with a host.");
        }
        Duration chosen = timeout == null || timeout.isZero() || timeout.isNegative() ? Duration.ofSeconds(10) : timeout;
        this.timeout = chosen.compareTo(Duration.ofSeconds(1)) < 0 ? Duration.ofSeconds(1) : chosen;
        this.credentials = credentials;
        this.transport = Objects.requireNonNull(transport, "transport");
        String asked = policy == null || policy.isBlank() ? null : policy.strip();
        if (asked != null && !Der.validOid(asked)) {
            throw new IllegalArgumentException("The requested timestamp policy " + asked + " is not an object identifier.");
        }
        this.policy = asked;
    }

    /** The timestamp server asked. */
    public URI url() {
        return url;
    }

    /** The {@code reqPolicy} every request carries, dotted, or {@code null} for none. */
    public String policy() {
        return policy;
    }

    /**
     * A granted timestamp over data: a SHA-256 imprint, the server's certificate asked for, no nonce, the configured policy (if any).
     *
     * @param channel unused by a remote server; kept for {@link Timestamper}
     * @throws TimestampClientException when none came
     */
    @Override
    public byte[] stamp(byte[] data, String channel) {
        byte[] reply = request(TimestampQuery.forData(data, TimestampQuery.SHA256, true, null, policy));
        if (policy != null) {
            // RFC 3161 2.4.2: a server asked for a reqPolicy issues under it or rejects the request. One that grants under
            // its own default instead would put a token under a policy nobody asked for into the seal, so it is no token.
            // The token is read here only when a policy was asked: otherwise what it holds is checked by
            // whoever reads it, as before.
            String issued;
            try {
                issued = TimestampToken.fromResponse(reply).policy();
            } catch (RuntimeException e) {
                issued = null;
            }
            if (!policy.equals(issued)) {
                throw new TimestampClientException(200, String.format("No timestamp from %s: %s.", url, issued == null
                    ? "it granted a timestamp whose policy cannot be read, and the policy " + policy + " was asked for"
                    : "it granted a timestamp under the policy " + issued + ", not the policy " + policy + " asked for"));
            }
        }
        return reply;
    }

    /**
     * Posts a TimeStampReq and returns the granted TimeStampResp.
     *
     * @throws TimestampClientException when none came
     */
    public byte[] request(byte[] query) {
        String problem;
        int status = 0;
        try {
            Map<String, String> headers = new LinkedHashMap<>();
            headers.put("Content-Type", "application/timestamp-query");
            headers.put("Accept", "application/timestamp-reply");
            if (credentials != null) {
                headers.put("Authorization", credentials.header());
            }
            TsaTransport.Reply response = transport.post(url, query, headers, timeout);
            status = response.status();
            // A reply that grants nothing says why: its PKIStatus, the PKIFailureInfo bits and the statusString
            // are added to the message, so an operator can tell unacceptedPolicy from any other refusal.
            if (status != 200) {
                problem = String.format("it answered HTTP %d", status) + why(response.body());
            } else if (!granted(response.body())) {
                problem = "it did not grant a timestamp" + why(response.body());
            } else {
                return response.body();
            }
        } catch (TsaTransportException e) {
            status = e.status();
            problem = e.getMessage() == null ? "the request failed" : e.getMessage();
        }
        throw new TimestampClientException(status, String.format("No timestamp from %s: %s.", url, problem.replaceAll("\\.+$", "")));
    }

    /** The longest statusString carried into a message: the server's words, for a log. */
    private static final int MAX_STATUS_TEXT = 200;

    /**
     * What a TimeStampResp that grants nothing says about why, as {@code " (rejection, unacceptedPolicy: \"...\")"}, or
     * empty when the body is not one (an HTML error page, nothing). The statusString is the server's text: its control
     * characters become spaces and it is cut at {@value #MAX_STATUS_TEXT} characters, so it cannot forge a log line.
     */
    static String why(byte[] body) {
        if (body == null || body.length == 0) {
            return "";
        }
        PKIStatusInfo info;
        try {
            info = TimeStampResp.getInstance(body).getStatus();
        } catch (RuntimeException e) {
            return "";
        }
        if (info == null || info.getStatus() == null) {
            return "";
        }
        List<String> parts = new ArrayList<>();
        int code = info.getStatus().intValue();
        parts.add(switch (code) {
            case 0 -> "granted";
            case 1 -> "grantedWithMods";
            case 2 -> "rejection";
            case 3 -> "waiting";
            case 4 -> "revocationWarning";
            case 5 -> "revocationNotification";
            default -> "status " + info.getStatus();
        });
        ASN1BitString failInfo = info.getFailInfo();
        if (failInfo != null) {
            byte[] bits = failInfo.getBytes();
            for (int bit = 0; bit < bits.length * 8; bit++) {
                if ((bits[bit / 8] & (0x80 >> (bit % 8))) != 0) {
                    parts.add(TimestampRefusal.nameOf(bit));
                }
            }
        }
        String text = "";
        PKIFreeText words = info.getStatusString();
        if (words != null) {
            List<String> lines = new ArrayList<>();
            for (int i = 0; i < words.size(); i++) {
                lines.add(words.getStringAtUTF8(i).getString());
            }
            StringBuilder clean = new StringBuilder();
            String joined = String.join("; ", lines);
            for (int i = 0; i < joined.length() && clean.length() < MAX_STATUS_TEXT; i++) {
                char c = joined.charAt(i);
                clean.append(Character.isISOControl(c) || c == '\u2028' || c == '\u2029' ? ' ' : c);
            }
            text = clean.toString().strip();
            if (joined.length() > MAX_STATUS_TEXT) {
                text = text + "...";
            }
        }
        return " (" + String.join(", ", parts) + (text.isEmpty() ? "" : ": \"" + text + "\"") + ")";
    }

    /**
     * Whether a TimeStampResp's status is granted (0) or granted with modifications (1): the first INTEGER inside
     * the second SEQUENCE. Read leniently (BER lengths taken): only the status is decided here, and what the token
     * holds is checked by whoever reads it.
     */
    public static boolean granted(byte[] der) {
        if (der == null) {
            return false;
        }
        int offset = 0;
        for (int i = 0; i < 2; i++) {
            if (offset >= der.length || (der[offset] & 0xff) != 0x30) {
                return false;
            }
            offset = afterLength(der, offset + 1);
            if (offset < 0) {
                return false;
            }
        }
        if (offset + 2 >= der.length || (der[offset] & 0xff) != 0x02 || (der[offset + 1] & 0xff) != 0x01) {
            return false;
        }
        int status = der[offset + 2] & 0xff;
        return status == 0 || status == 1;
    }

    /** The offset after a length that starts at the offset, or -1. */
    private static int afterLength(byte[] der, int offset) {
        if (offset >= der.length) {
            return -1;
        }
        int first = der[offset] & 0xff;
        if (first < 0x80) {
            return offset + 1;
        }
        int count = first & 0x7f;
        return count >= 1 && count <= 4 && der.length > offset + count ? offset + 1 + count : -1;
    }
}
