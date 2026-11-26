package com.argusvane.datum.pdf.spring;

import com.argusvane.datum.timestamp.TsaTransport;
import com.argusvane.datum.timestamp.TsaTransportException;
import java.io.InputStream;
import java.net.URI;
import java.time.Duration;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executor;
import java.util.concurrent.FutureTask;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import org.springframework.core.task.SimpleAsyncTaskExecutor;
import org.springframework.http.HttpHeaders;
import org.springframework.web.client.RestClient;

/**
 * The timestamp client's HTTP carried by Spring's {@link RestClient} (framework-first: the host's
 * {@code RestClient.Builder} is where proxy, timeouts, TLS, observation and metrics are configured, so the one outbound
 * HTTP client of the JVM code rides it). Built by {@link DatumPdfAutoConfiguration} from the auto-configured builder, so
 * every {@code RestClientCustomizer} the application declares has been applied, and
 * {@code datum.pdf.signing.tsa.ssl-bundle} gives the TLS settings.
 *
 * <p>The transport's contract is kept on top of the client: every status is an answer (the exchange is read raw, so a 4xx
 * or 5xx is not thrown), the reply is read up to {@link TsaTransport#MAX_REPLY_BYTES}, and the call is bounded by the
 * timeout asked. The factory this client is built over never follows a redirect (the binding sets it), so a credential
 * goes to the URL named and nowhere else. The deadline runs the exchange on a thread of its own and abandons it at the
 * timeout, because a blocking socket read cannot be interrupted; the request factory's read timeout (the binding sets it to the
 * TSA timeout, or a shorter {@code spring.http.client.read-timeout}) ends that thread and frees the connection. The caller is already off any event loop: the PDF
 * service seals on its blocking pool.
 *
 * <p>The thread comes from an executor: the
 * binding's is one thread per call, never a pool a stalled call could queue behind, from Spring Boot's
 * {@code SimpleAsyncTaskExecutorBuilder} (so a virtual thread under {@code spring.threads.virtual.enabled}, and the
 * application's {@code TaskDecorator}s), with the caller's MDC and current observation carried across, so the RestClient's
 * own observation of the call is a child of the seal or receipt that asked. The deadline contract stays: abandoned at the
 * timeout, ended by the read timeout.
 */
public final class RestClientTsaTransport implements TsaTransport {

    private final RestClient client;
    private final Executor executor;

    /** On a daemon thread per call that carries the caller's MDC (no observation registry: none to carry). */
    public RestClientTsaTransport(RestClient client) {
        this(client, perCall(null));
    }

    /**
     * @param executor runs each call; it must start every call at once on a thread of its own (an unbounded thread per
     *     task): a bounded pool would queue a call behind stalled ones past its deadline
     */
    public RestClientTsaTransport(RestClient client, Executor executor) {
        this.client = Objects.requireNonNull(client, "client");
        this.executor = Objects.requireNonNull(executor, "executor");
    }

    /** A daemon thread per call, named {@code datum-tsa-transport-<n>}, carrying the MDC and the observation of {@code registry}. */
    static SimpleAsyncTaskExecutor perCall(io.micrometer.observation.ObservationRegistry registry) {
        SimpleAsyncTaskExecutor executor = new SimpleAsyncTaskExecutor(THREAD_PREFIX);
        executor.setDaemon(true);
        executor.setTaskDecorator(new TsaCallContext(registry));
        return executor;
    }

    /** The name every call's thread starts with. */
    static final String THREAD_PREFIX = "datum-tsa-transport-";

    @Override
    public Reply post(URI url, byte[] query, Map<String, String> headers, Duration timeout) {
        FutureTask<Reply> call = new FutureTask<>(() -> client.post().uri(url)
            .headers(sent -> headers.forEach(sent::set))
            .body(query)
            .exchange((request, response) -> {
                int status = response.getStatusCode().value();
                String contentType = response.getHeaders().getFirst(HttpHeaders.CONTENT_TYPE);
                // Only a 200 carries a token; any other status is read no further.
                if (status != 200) {
                    return new Reply(status, contentType, new byte[0]);
                }
                try (InputStream in = response.getBody()) {
                    byte[] body = in.readNBytes(MAX_REPLY_BYTES + 1);
                    if (body.length > MAX_REPLY_BYTES) {
                        throw TsaTransportException.tooLarge(null);
                    }
                    return new Reply(status, contentType, body);
                }
            }));
        try {
            executor.execute(call);
        } catch (RejectedExecutionException e) {
            throw TsaTransportException.failed(e);
        }
        try {
            return call.get(timeout.toNanos(), TimeUnit.NANOSECONDS);
        } catch (TimeoutException e) {
            call.cancel(true);
            throw TsaTransportException.timedOut(timeout, e);
        } catch (ExecutionException e) {
            Throwable cause = e.getCause() == null ? e : e.getCause();
            if (cause instanceof TsaTransportException refusal) {
                throw refusal;
            }
            throw TsaTransportException.failed(cause);
        } catch (InterruptedException e) {
            call.cancel(true);
            Thread.currentThread().interrupt();
            throw TsaTransportException.interrupted(e);
        }
    }
}
