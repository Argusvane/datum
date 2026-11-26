package com.argusvane.datum.webauthn.web.webflux;

import com.argusvane.datum.springweb.webflux.WebFluxBodies;
import com.argusvane.datum.webauthn.web.PasskeysApi;
import com.argusvane.datum.webauthn.web.PasskeysReply;
import com.argusvane.datum.webauthn.web.PasskeysRequest;
import java.security.Principal;
import java.util.Optional;
import java.util.function.BiFunction;
import java.util.function.Function;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.MediaType;
import org.springframework.web.reactive.function.server.ServerRequest;
import org.springframework.web.reactive.function.server.ServerResponse;
import com.argusvane.datum.springweb.webflux.WebFluxRequestViews;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Scheduler;
import reactor.core.scheduler.Schedulers;

/**
 * The WebFlux handlers of the passkey endpoints: the same {@link PasskeysApi} calls the MVC controller makes, run
 * on the elastic scheduler because the stores block. The challenge and the registration ask {@link PasskeysApi#admit}
 * first (415, then the address limit), on the scheduler because a replacement throttle may block; a body is then read
 * raw with {@link WebFluxBodies} (415, then the cap counted on the stream) before the work is scheduled. Failures travel as Datum exceptions in the Mono;
 * {@code DatumWebFluxExceptionHandler} answers them for the paths the route registry holds.
 */
public final class PasskeysWebFluxHandlers {

    private final PasskeysApi api;
    private final Scheduler scheduler;

    /** On Reactor's elastic scheduler, the default for blocking work. */
    public PasskeysWebFluxHandlers(PasskeysApi api) {
        this(api, Schedulers.boundedElastic());
    }

    /**
     * @param scheduler where the blocking calls run: the application's {@code Scheduler} bean when it defines one, else the elastic scheduler
     */
    public PasskeysWebFluxHandlers(PasskeysApi api, Scheduler scheduler) {
        this.api = api;
        this.scheduler = scheduler;
    }

    public Mono<ServerResponse> challenge(ServerRequest request) {
        return counted(request, api::challenge);
    }

    public Mono<ServerResponse> register(ServerRequest request) {
        return counted(request, api::register);
    }

    public Mono<ServerResponse> mine(ServerRequest request) {
        String form = request.queryParam("form").orElse(null);
        return noBody(request, view -> api.mine(form, view));
    }

    public Mono<ServerResponse> remove(ServerRequest request) {
        String id = request.pathVariable("id");
        return noBody(request, view -> api.revoke(id, view));
    }

    public Mono<ServerResponse> checkChallenge(ServerRequest request) {
        String id = request.pathVariable("id");
        return noBody(request, view -> api.checkChallenge(id, view));
    }

    public Mono<ServerResponse> check(ServerRequest request) {
        String id = request.pathVariable("id");
        return withBody(request, (body, view) -> api.check(id, body, view));
    }

    private Mono<ServerResponse> withBody(ServerRequest request, BiFunction<byte[], PasskeysRequest, PasskeysReply> work) {
        return WebFluxBodies.readJsonBytes(request.exchange().getRequest(), api.maxBodyBytes())
            .flatMap(body -> principal(request)
                .flatMap(principal -> Mono.fromCallable(() -> work.apply(body, view(request, principal.orElse(null))))
                    .subscribeOn(scheduler)))
            .flatMap(PasskeysWebFluxHandlers::response);
    }

    /** A route the throttle counts: the admission (415, the address limit) on the scheduler, then the body, then the work. */
    private Mono<ServerResponse> counted(ServerRequest request, BiFunction<byte[], PasskeysRequest, PasskeysReply> work) {
        return principal(request)
            .flatMap(principal -> {
                PasskeysRequest view = view(request, principal.orElse(null));
                return Mono.<Void>fromRunnable(() -> api.admit(view)).subscribeOn(scheduler)
                    .then(Mono.defer(() -> WebFluxBodies.readJsonBytes(request.exchange().getRequest(), api.maxBodyBytes())))
                    .flatMap(body -> Mono.fromCallable(() -> work.apply(body, view)).subscribeOn(scheduler));
            })
            .flatMap(PasskeysWebFluxHandlers::response);
    }

    private Mono<ServerResponse> noBody(ServerRequest request, Function<PasskeysRequest, PasskeysReply> work) {
        return principal(request)
            .flatMap(principal -> Mono.fromCallable(() -> work.apply(view(request, principal.orElse(null))))
                .subscribeOn(scheduler))
            .flatMap(PasskeysWebFluxHandlers::response);
    }

    private static Mono<Optional<Principal>> principal(ServerRequest request) {
        return WebFluxRequestViews.principal(request);
    }

    private static PasskeysRequest view(ServerRequest request, Principal principal) {
        return new PasskeysRequest(WebFluxRequestViews.contentType(request), WebFluxRequestViews.headers(request),
            WebFluxRequestViews.remoteAddress(request), principal);
    }

    private static Mono<ServerResponse> response(PasskeysReply reply) {
        ServerResponse.BodyBuilder builder = ServerResponse.status(HttpStatusCode.valueOf(reply.status()));
        reply.headers().forEach(builder::header);
        return builder.contentType(MediaType.parseMediaType(PasskeysApi.contentType())).bodyValue(reply.body());
    }
}
