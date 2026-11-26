package com.argusvane.datum.timestamp;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.ByteBuffer;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Flow;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * The default {@link TsaTransport}, on the JDK's {@link HttpClient}. The client is the caller's to supply, so a proxy,
 * an {@code SSLContext}, an executor or an authenticator are the JDK's own knobs; with none it builds one that
 * connects within five seconds.
 *
 * <p>Requests go out as plain HTTP/1.1, as RFC 3161 section 3.4 describes the exchange (the JDK's default HTTP/2
 * would offer an h2c upgrade on a body-carrying POST to an http URL), and a supplied client must not follow redirects:
 * the constructor refuses one that would, because a credential must go to the URL named and nowhere else. One deadline
 * bounds headers and body alike: a server that trickles its reply is cut off at the
 * deadline rather than holding a sealing or receipt thread. The reply is read up to {@link #MAX_REPLY_BYTES}; a longer
 * one (or a Content-Length announcing one) is refused and the exchange cancelled.
 */
public final class JdkTsaTransport implements TsaTransport {

    private final HttpClient http;

    /** A transport over a client built here: no redirects, a five-second connect timeout. */
    public JdkTsaTransport() {
        this(HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).connectTimeout(Duration.ofSeconds(5)).build());
    }

    /**
     * @param http the client to use; its proxy, SSL context, executor and authenticator apply
     * @throws IllegalArgumentException when the client follows redirects
     */
    public JdkTsaTransport(HttpClient http) {
        this.http = Objects.requireNonNull(http, "http");
        if (http.followRedirects() != HttpClient.Redirect.NEVER) {
            throw new IllegalArgumentException("The HTTP client for a timestamp server must not follow redirects "
                + "(HttpClient.Redirect.NEVER): a credential goes to the URL named and nowhere else.");
        }
    }

    @Override
    public Reply post(URI url, byte[] query, Map<String, String> headers, Duration timeout) {
        long deadline = System.nanoTime() + timeout.toNanos();
        CompletableFuture<HttpResponse<byte[]>> exchange = null;
        try {
            HttpRequest.Builder request = HttpRequest.newBuilder(url)
                .version(HttpClient.Version.HTTP_1_1)
                .timeout(timeout)
                .POST(HttpRequest.BodyPublishers.ofByteArray(query));
            headers.forEach(request::header);
            // The body handler reads a 200 reply up to the cap and drops any other; the future completes when the
            // body has been read, so one deadline bounds headers and body alike.
            exchange = http.sendAsync(request.build(), info -> info.statusCode() == 200
                ? new CappedBody(MAX_REPLY_BYTES, info.headers().firstValueAsLong("Content-Length").orElse(-1))
                : HttpResponse.BodySubscribers.replacing((byte[]) null));
            HttpResponse<byte[]> response = exchange.get(Math.max(0, deadline - System.nanoTime()), TimeUnit.NANOSECONDS);
            byte[] body = response.body();
            return new Reply(response.statusCode(), response.headers().firstValue("Content-Type").orElse(null), body == null ? new byte[0] : body);
        } catch (TimeoutException e) {
            exchange.cancel(true);
            throw TsaTransportException.timedOut(timeout, e);
        } catch (ExecutionException e) {
            Throwable cause = e.getCause() == null ? e : e.getCause();
            if (tooLarge(cause)) {
                throw TsaTransportException.tooLarge(cause);
            }
            throw TsaTransportException.failed(cause);
        } catch (IllegalArgumentException e) {
            // A header value the JDK refuses (a credential with a line break, say): no request was sent.
            throw new TsaTransportException(0, "the request could not be made: " + e.getMessage(), e);
        } catch (InterruptedException e) {
            if (exchange != null) {
                exchange.cancel(true);
            }
            Thread.currentThread().interrupt();
            throw TsaTransportException.interrupted(e);
        }
    }

    private static boolean tooLarge(Throwable failure) {
        for (Throwable t = failure; t != null; t = t.getCause()) {
            if (t instanceof ReplyTooLarge) {
                return true;
            }
        }
        return false;
    }

    /** A reply longer than the cap. */
    private static final class ReplyTooLarge extends IOException {
        private static final long serialVersionUID = 1L;

        ReplyTooLarge() {
            super("reply too large");
        }
    }

    /**
     * Collects a body up to a cap and cancels the exchange past it (or at once when Content-Length announces more):
     * the JDK has no limiting subscriber before Java 25, and the library builds for Java 17.
     */
    private static final class CappedBody implements HttpResponse.BodySubscriber<byte[]> {

        private final int cap;
        private final long announced;
        private final CompletableFuture<byte[]> body = new CompletableFuture<>();
        private final ByteArrayOutputStream out = new ByteArrayOutputStream();
        private Flow.Subscription subscription;

        CappedBody(int cap, long announced) {
            this.cap = cap;
            this.announced = announced;
        }

        @Override
        public CompletionStage<byte[]> getBody() {
            return body;
        }

        @Override
        public void onSubscribe(Flow.Subscription subscription) {
            this.subscription = subscription;
            if (announced > cap) {
                subscription.cancel();
                body.completeExceptionally(new ReplyTooLarge());
                return;
            }
            subscription.request(Long.MAX_VALUE);
        }

        @Override
        public void onNext(List<ByteBuffer> items) {
            if (body.isDone()) {
                return;
            }
            for (ByteBuffer item : items) {
                if (out.size() + item.remaining() > cap) {
                    subscription.cancel();
                    body.completeExceptionally(new ReplyTooLarge());
                    return;
                }
                byte[] chunk = new byte[item.remaining()];
                item.get(chunk);
                out.write(chunk, 0, chunk.length);
            }
        }

        @Override
        public void onError(Throwable throwable) {
            body.completeExceptionally(throwable);
        }

        @Override
        public void onComplete() {
            body.complete(out.toByteArray());
        }
    }
}
