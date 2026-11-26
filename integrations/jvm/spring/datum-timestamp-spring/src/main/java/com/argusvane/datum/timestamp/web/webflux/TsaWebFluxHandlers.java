package com.argusvane.datum.timestamp.web.webflux;

import com.argusvane.datum.timestamp.TsaClient;
import com.argusvane.datum.timestamp.web.TsaEndpoint;
import com.argusvane.datum.timestamp.web.TsaHttpReply;
import com.argusvane.datum.timestamp.web.TsaRequest;
import java.net.InetSocketAddress;
import java.util.Optional;
import org.springframework.core.io.buffer.DataBuffer;
import org.springframework.core.io.buffer.DataBufferLimitException;
import org.springframework.core.io.buffer.DataBufferUtils;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.MediaType;
import org.springframework.web.reactive.function.BodyExtractors;
import org.springframework.web.reactive.function.server.ServerRequest;
import org.springframework.web.reactive.function.server.ServerResponse;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Scheduler;
import reactor.core.scheduler.Schedulers;

/**
 * The timestamp server on WebFlux: the same {@link TsaEndpoint} calls the MVC controller makes. The decisions
 * before the body (a client key may be looked up in a database) and the signing run on the elastic scheduler
 * because they block; the body is read with the limit, and a request that goes over it is answered 413 without
 * buffering the rest. Failures that are bugs propagate as errors: {@code DatumWebFluxExceptionHandler} answers
 * them for the paths the route registry holds.
 */
public final class TsaWebFluxHandlers {

    private final TsaEndpoint endpoint;
    private final Scheduler scheduler;

    /** On Reactor's elastic scheduler, the default for blocking work. */
    public TsaWebFluxHandlers(TsaEndpoint endpoint) {
        this(endpoint, Schedulers.boundedElastic());
    }

    /**
     * @param scheduler where the blocking calls run: the application's {@code Scheduler} bean when it defines one, else the elastic scheduler
     */
    public TsaWebFluxHandlers(TsaEndpoint endpoint, Scheduler scheduler) {
        this.endpoint = endpoint;
        this.scheduler = scheduler;
    }

    public Mono<ServerResponse> issue(ServerRequest request) {
        TsaRequest summary = new TsaRequest(request.headers().firstHeader("Content-Type"), request.headers().firstHeader("Authorization"),
            request.cookies().keySet(), request.remoteAddress().map(TsaWebFluxHandlers::host).orElse(""),
            request.headers().contentLength().orElse(-1));
        return Mono.fromCallable(() -> endpoint.admit(summary)).subscribeOn(scheduler)
            .flatMap(admission -> {
                if (!admission.admitted()) {
                    return response(admission.refusal());
                }
                return body(request).flatMap(body -> answer(body, admission.client()));
            });
    }

    private Mono<ServerResponse> answer(Optional<byte[]> body, TsaClient client) {
        if (body.isEmpty()) {
            return response(endpoint.tooLarge());
        }
        Mono<TsaHttpReply> reply = Mono.fromCallable(() -> endpoint.issue(body.get(), client)).subscribeOn(scheduler);
        return reply.flatMap(TsaWebFluxHandlers::response);
    }

    public Mono<ServerResponse> certificate(ServerRequest request) {
        return Mono.fromCallable(() -> endpoint.certificate(request.queryParam("format").orElse(null)))
            .subscribeOn(scheduler).flatMap(TsaWebFluxHandlers::response);
    }

    public Mono<ServerResponse> certificates(ServerRequest request) {
        return Mono.fromCallable(endpoint::certificates).subscribeOn(scheduler).flatMap(TsaWebFluxHandlers::response);
    }

    /** The body, at most one byte over the limit; an empty optional means it went over. */
    private Mono<Optional<byte[]>> body(ServerRequest request) {
        int limit = (int) Math.min(Integer.MAX_VALUE - 8, endpoint.maxBody() + 1);
        return DataBufferUtils.join(request.body(BodyExtractors.toDataBuffers()), limit)
            .map(TsaWebFluxHandlers::bytes)
            .map(bytes -> bytes.length > endpoint.maxBody() ? Optional.<byte[]>empty() : Optional.of(bytes))
            .defaultIfEmpty(Optional.of(new byte[0]))
            .onErrorResume(DataBufferLimitException.class, e -> Mono.just(Optional.empty()));
    }

    private static byte[] bytes(DataBuffer buffer) {
        try {
            byte[] bytes = new byte[buffer.readableByteCount()];
            buffer.read(bytes);
            return bytes;
        } finally {
            DataBufferUtils.release(buffer);
        }
    }

    private static String host(InetSocketAddress address) {
        return address.getAddress() != null ? address.getAddress().getHostAddress() : address.getHostString();
    }

    private static Mono<ServerResponse> response(TsaHttpReply reply) {
        ServerResponse.BodyBuilder builder = ServerResponse.status(HttpStatusCode.valueOf(reply.status()));
        reply.headers().forEach(builder::header);
        return builder.contentType(MediaType.parseMediaType(reply.contentType())).bodyValue(reply.body());
    }
}
