package com.argusvane.datum.ui.builder.webflux;

import com.argusvane.datum.forms.web.FormsApi;
import com.argusvane.datum.forms.web.FormsReply;
import com.argusvane.datum.springweb.webflux.WebFluxBodies;
import com.argusvane.datum.ui.builder.Admission;
import com.argusvane.datum.ui.builder.BuilderApi;
import com.argusvane.datum.ui.builder.LocaleChanges;
import java.security.Principal;
import java.util.Optional;
import java.util.function.Supplier;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.MediaType;
import org.springframework.web.reactive.function.server.ServerRequest;
import org.springframework.web.reactive.function.server.ServerResponse;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Scheduler;
import reactor.core.scheduler.Schedulers;

/**
 * The builder's write endpoints on WebFlux: the same {@link BuilderApi} calls the MVC controller makes, in the
 * same order. The admission (existence; who may write is the application's security) and the write run on the elastic scheduler because they block
 * (the repository, the kernel's check); the body in between is read without blocking, with the definition cap
 * counted on the raw stream ({@link WebFluxBodies}: 415, 413). Failures travel as Datum exceptions in the Mono;
 * {@code DatumWebFluxExceptionHandler} answers them for the registered paths. A header sent on several lines is
 * read whole ({@link BuilderApi#header}), as the MVC controller reads it.
 */
public final class BuilderWebFluxHandlers {

    private final BuilderApi api;
    private final Scheduler scheduler;

    /** On Reactor's elastic scheduler, the default for blocking work. */
    public BuilderWebFluxHandlers(BuilderApi api) {
        this(api, Schedulers.boundedElastic());
    }

    /**
     * @param scheduler where the blocking calls run: the application's {@code Scheduler} bean when it defines one, else the elastic scheduler
     */
    public BuilderWebFluxHandlers(BuilderApi api, Scheduler scheduler) {
        this.api = api;
        this.scheduler = scheduler;
    }

    public Mono<ServerResponse> create(ServerRequest request) {
        String changes = BuilderApi.header(request.headers().header(LocaleChanges.HEADER));
        return write(request, api::admitCreate,
            (admission, body, principal) -> api.create(admission, body, changes, principal));
    }

    public Mono<ServerResponse> update(ServerRequest request) {
        String key = request.pathVariable("key");
        String ifMatch = BuilderApi.header(request.headers().header("If-Match"));
        String changes = BuilderApi.header(request.headers().header(LocaleChanges.HEADER));
        return write(request, () -> api.admitUpdate(key),
            (admission, body, principal) -> api.update(admission, body, ifMatch, changes, principal));
    }

    public Mono<ServerResponse> translations(ServerRequest request) {
        String key = request.pathVariable("key");
        String ifMatch = BuilderApi.header(request.headers().header("If-Match"));
        return write(request, () -> api.admitTranslations(key),
            (admission, body, principal) -> api.translations(admission, body, ifMatch, principal));
    }

    /** One write: the admission, the body, then the write with the exchange's principal (who saves). */
    @FunctionalInterface
    private interface Write {
        FormsReply apply(Admission admission, byte[] body, Principal principal);
    }

    private Mono<ServerResponse> write(ServerRequest request, Supplier<Admission> admit, Write work) {
        return Mono.fromCallable(admit::get).subscribeOn(scheduler)
            .flatMap(admission -> WebFluxBodies.readJsonBytes(request.exchange().getRequest(), api.maxDefinitionBytes())
                .flatMap(body -> request.principal().map(Optional::<Principal>of).defaultIfEmpty(Optional.empty())
                    .flatMap(principal -> Mono.fromCallable(() -> work.apply(admission, body, principal.orElse(null))).subscribeOn(scheduler))))
            .flatMap(BuilderWebFluxHandlers::response);
    }

    private static Mono<ServerResponse> response(FormsReply reply) {
        ServerResponse.BodyBuilder builder = ServerResponse.status(HttpStatusCode.valueOf(reply.status()));
        reply.headers().forEach(builder::header);
        return builder.contentType(MediaType.parseMediaType(FormsApi.contentType())).bodyValue(reply.body());
    }
}
