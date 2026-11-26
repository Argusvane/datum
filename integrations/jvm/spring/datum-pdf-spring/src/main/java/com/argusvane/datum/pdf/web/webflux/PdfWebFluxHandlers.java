package com.argusvane.datum.pdf.web.webflux;

import com.argusvane.datum.pdf.api.PdfApi;
import com.argusvane.datum.pdf.api.PdfReply;
import com.argusvane.datum.springweb.webflux.WebFluxBodies;
import com.argusvane.datum.submissions.spi.SubmissionRequest;
import java.security.Principal;
import java.util.Optional;
import java.util.function.BiFunction;
import java.util.function.Consumer;
import java.util.function.Supplier;
import org.springframework.core.io.buffer.DataBufferLimitException;
import org.springframework.core.io.buffer.DataBufferUtils;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.MediaType;
import org.springframework.web.reactive.function.server.ServerRequest;
import org.springframework.web.reactive.function.server.ServerResponse;
import com.argusvane.datum.springweb.webflux.WebFluxRequestViews;
import com.argusvane.datum.submissions.web.webflux.SubmissionRequestResolver;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Scheduler;
import reactor.core.scheduler.Schedulers;

/**
 * The WebFlux handlers of the PDF endpoints: the same {@link PdfApi} calls the MVC controllers make, run on the elastic
 * scheduler because they block (a render takes seconds, the sandbox and the data sources are blocking calls). Every
 * route but the certificate asks {@link PdfApi#admitJson} or {@link PdfApi#admitPdf} first (415, then the address
 * limit), on the scheduler because a replacement throttle may block; only then is a JSON body read raw with
 * {@link WebFluxBodies} (415, then the cap counted on the stream), or a posted PDF in the same order under the PDF cap. Failures travel as Datum exceptions in the Mono;
 * {@code DatumWebFluxExceptionHandler} answers them for the paths the route registry holds.
 */
public final class PdfWebFluxHandlers {

    private final PdfApi api;
    private final Scheduler scheduler;

    /** On Reactor's elastic scheduler, the default for blocking work. */
    public PdfWebFluxHandlers(PdfApi api) {
        this(api, Schedulers.boundedElastic());
    }

    /**
     * @param scheduler where the blocking calls run: the application's {@code Scheduler} bean when it defines one, else the elastic scheduler
     */
    public PdfWebFluxHandlers(PdfApi api, Scheduler scheduler) {
        this.api = api;
        this.scheduler = scheduler;
    }

    public Mono<ServerResponse> pdf(ServerRequest request) {
        return json(request, api::pdf);
    }

    public Mono<ServerResponse> fill(ServerRequest request) {
        return json(request, api::fill);
    }

    public Mono<ServerResponse> sign(ServerRequest request) {
        return json(request, api::sign);
    }

    public Mono<ServerResponse> verify(ServerRequest request) {
        return admitted(request, api::admitPdf, () -> pdfBody(request), api::verify);
    }

    public Mono<ServerResponse> certificate(ServerRequest request) {
        return principal(request).flatMap(principal -> Mono.fromCallable(() -> api.certificate(SubmissionRequestResolver.view(request, principal.orElse(null))))
            .subscribeOn(scheduler)).flatMap(PdfWebFluxHandlers::response);
    }

    private Mono<ServerResponse> json(ServerRequest request, BiFunction<byte[], SubmissionRequest, PdfReply> operation) {
        return admitted(request, api::admitJson, () -> WebFluxBodies.readJsonBytes(request.exchange().getRequest(), api.maxBodyBytes()), operation);
    }

    /** The admission (415, the address limit) on the scheduler, then the body read, then the work on the scheduler. */
    private Mono<ServerResponse> admitted(ServerRequest request, Consumer<SubmissionRequest> admission, Supplier<Mono<byte[]>> body,
                                          BiFunction<byte[], SubmissionRequest, PdfReply> operation) {
        return principal(request)
            .flatMap(principal -> {
                SubmissionRequest view = SubmissionRequestResolver.view(request, principal.orElse(null));
                return Mono.<Void>fromRunnable(() -> admission.accept(view)).subscribeOn(scheduler)
                    .then(Mono.defer(body))
                    .flatMap(bytes -> Mono.fromCallable(() -> operation.apply(bytes, view)).subscribeOn(scheduler));
            })
            .flatMap(PdfWebFluxHandlers::response);
    }

    /** A posted PDF: 415 for another type (again: the admission asked first), 413 past the PDF cap (declared or counted on the stream). */
    private Mono<byte[]> pdfBody(ServerRequest request) {
        try {
            api.requirePdfContent(request.headers().firstHeader("Content-Type"));
        } catch (RuntimeException refusal) {
            return Mono.error(refusal);
        }
        long cap = api.maxPdfBytes();
        if (request.exchange().getRequest().getHeaders().getContentLength() > cap) {
            return Mono.error(api.fileTooLarge());
        }
        int limit = (int) Math.min(Integer.MAX_VALUE - 8, cap);
        return DataBufferUtils.join(request.exchange().getRequest().getBody(), limit)
            .map(buffer -> {
                try {
                    byte[] bytes = new byte[buffer.readableByteCount()];
                    buffer.read(bytes);
                    return bytes;
                } finally {
                    DataBufferUtils.release(buffer);
                }
            })
            .onErrorMap(DataBufferLimitException.class, e -> api.fileTooLarge())
            .defaultIfEmpty(new byte[0]);
    }

    private static Mono<Optional<Principal>> principal(ServerRequest request) {
        return WebFluxRequestViews.principal(request);
    }

    private static Mono<ServerResponse> response(PdfReply reply) {
        ServerResponse.BodyBuilder builder = ServerResponse.status(HttpStatusCode.valueOf(reply.status()));
        reply.headers().forEach(builder::header);
        return builder.contentType(MediaType.parseMediaType(reply.contentType())).bodyValue(reply.body());
    }
}
