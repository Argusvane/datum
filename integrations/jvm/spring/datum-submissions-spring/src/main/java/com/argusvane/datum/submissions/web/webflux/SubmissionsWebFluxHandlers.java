package com.argusvane.datum.submissions.web.webflux;

import com.argusvane.datum.springweb.webflux.WebFluxBodies;
import com.argusvane.datum.submissions.spi.SubmissionMode;
import com.argusvane.datum.submissions.spi.SubmissionRequest;
import com.argusvane.datum.submissions.web.SubmissionsApi;
import com.argusvane.datum.submissions.web.SubmissionsReply;
import java.util.function.BiFunction;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.MediaType;
import org.springframework.web.reactive.function.server.ServerRequest;
import org.springframework.web.reactive.function.server.ServerResponse;
import com.argusvane.datum.springweb.webflux.WebFluxRequestViews;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Scheduler;
import reactor.core.scheduler.Schedulers;

/**
 * The WebFlux handlers of the submissions endpoints: the same {@link SubmissionsApi} calls the MVC controllers
 * make, run on the elastic scheduler because they block (the sandbox, the data sources). The submit, validate and
 * test routes ask {@link SubmissionsApi#admit} first (415, then the address limit), on the scheduler because a
 * replacement throttle may block; only then is the body read raw with {@link WebFluxBodies} (415, then the cap counted
 * on the stream), so a body that never parses is counted and a request over the address limit is refused unread. Failures
 * travel as Datum exceptions in the Mono; {@code DatumWebFluxExceptionHandler} answers them for the paths the
 * route registry holds.
 */
public final class SubmissionsWebFluxHandlers {

    private final SubmissionsApi api;
    private final Scheduler scheduler;

    /** On Reactor's elastic scheduler, the default for blocking work. */
    public SubmissionsWebFluxHandlers(SubmissionsApi api) {
        this(api, Schedulers.boundedElastic());
    }

    /**
     * @param scheduler where the blocking calls run: the application's {@code Scheduler} bean when it defines one, else the elastic scheduler
     */
    public SubmissionsWebFluxHandlers(SubmissionsApi api, Scheduler scheduler) {
        this.api = api;
        this.scheduler = scheduler;
    }

    public Mono<ServerResponse> submit(ServerRequest request) {
        return call(request, SubmissionMode.SUBMIT, api::submit);
    }

    public Mono<ServerResponse> validate(ServerRequest request) {
        return call(request, SubmissionMode.VALIDATE, api::validate);
    }

    public Mono<ServerResponse> test(ServerRequest request) {
        return call(request, SubmissionMode.TEST, api::test);
    }

    /** The operator's inspection: not a throttled route, so no address limit. */
    public Mono<ServerResponse> inspect(ServerRequest request) {
        return call(request, null, api::inspect);
    }

    /**
     * @param mode the throttled route's mode, whose request the address limit counts before the body is read; null for none
     */
    private Mono<ServerResponse> call(ServerRequest request, SubmissionMode mode, BiFunction<byte[], SubmissionRequest, SubmissionsReply> work) {
        return WebFluxRequestViews.principal(request)
            .flatMap(principal -> {
                SubmissionRequest view = SubmissionRequestResolver.view(request, principal.orElse(null));
                Mono<Void> admitted = mode == null ? Mono.empty() : Mono.<Void>fromRunnable(() -> api.admit(mode, view)).subscribeOn(scheduler);
                return admitted
                    .then(Mono.defer(() -> WebFluxBodies.readJsonBytes(request.exchange().getRequest(), api.maxBodyBytes())))
                    .flatMap(body -> Mono.fromCallable(() -> work.apply(body, view)).subscribeOn(scheduler));
            })
            .flatMap(SubmissionsWebFluxHandlers::response);
    }

    private static Mono<ServerResponse> response(SubmissionsReply reply) {
        ServerResponse.BodyBuilder builder = ServerResponse.status(HttpStatusCode.valueOf(reply.status()));
        reply.headers().forEach(builder::header);
        return builder.contentType(MediaType.parseMediaType(SubmissionsApi.contentType())).bodyValue(reply.body());
    }
}
