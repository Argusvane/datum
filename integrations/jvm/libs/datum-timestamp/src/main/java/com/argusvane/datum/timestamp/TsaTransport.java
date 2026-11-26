package com.argusvane.datum.timestamp;

import java.net.URI;
import java.time.Duration;
import java.util.Map;
import java.util.Objects;

/**
 * How {@link TimestampClient} reaches a named RFC 3161 timestamp server: one POST, answered with the status, the
 * content type and the bytes. The seam exists so the HTTP client is the host's: a Spring application
 * lets {@code RestClient.Builder} (its customisers, proxy, TLS bundle, observation and metrics) carry the request, and
 * a plain application hands the default {@link JdkTsaTransport} its own {@code java.net.http.HttpClient}.
 *
 * <p>The contract a transport keeps, because the client trusts it to:
 * <ul>
 *   <li>It never follows a redirect (a redirect answer is returned as it is, and the client refuses it): a bearer token
 *       or a Basic credential is sent to the URL named and nowhere else.</li>
 *   <li>It bounds the whole exchange, connecting, headers and body, by the timeout, and reads at most
 *       {@link #MAX_REPLY_BYTES} of the reply.</li>
 *   <li>It returns every HTTP status as a {@link Reply} (a 4xx or 5xx is an answer, not an exception) and throws
 *       {@link TsaTransportException} only when no reply came: no connection, no answer in time, a reply over the cap.</li>
 * </ul>
 */
@FunctionalInterface
public interface TsaTransport {

    /** The longest reply read: a TimeStampResp with a long chain is a few kilobytes. */
    int MAX_REPLY_BYTES = 1 << 20;

    /**
     * Posts a request body.
     *
     * @param url     the server, an absolute http or https URL
     * @param query   the request body (a DER TimeStampReq)
     * @param headers the request headers ({@code Content-Type}, {@code Accept}, perhaps {@code Authorization}), each once
     * @param timeout how long the whole exchange may take
     * @return what the server answered, whatever the status
     * @throws TsaTransportException when no reply came
     */
    Reply post(URI url, byte[] query, Map<String, String> headers, Duration timeout);

    /**
     * An answer.
     *
     * @param status      the HTTP status
     * @param contentType the {@code Content-Type} header value, or null when the server sent none
     * @param body        the body (empty for none; never null)
     */
    record Reply(int status, String contentType, byte[] body) {

        public Reply {
            Objects.requireNonNull(body, "body");
        }
    }
}
