package com.argusvane.datum.forms.web.webflux;

import com.argusvane.datum.forms.web.FormsApi;
import com.argusvane.datum.forms.web.FormsReply;
import java.security.Principal;
import java.util.List;
import java.util.Optional;
import java.util.function.Function;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.MediaType;
import org.springframework.web.reactive.function.server.ServerRequest;
import org.springframework.web.reactive.function.server.ServerResponse;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Scheduler;
import reactor.core.scheduler.Schedulers;

/**
 * The WebFlux handlers of the forms read endpoints: the same {@link FormsApi} calls the MVC controllers make,
 * run on the elastic scheduler because they block (a public copy runs the kernel, a data source may take its
 * timeout). Failures travel as Datum exceptions in the Mono; {@code DatumWebFluxExceptionHandler} answers them
 * for the paths the route registry holds.
 */
public final class FormsWebFluxHandlers {

    private final FormsApi api;
    private final Scheduler scheduler;

    /** On Reactor's elastic scheduler, the default for blocking work. */
    public FormsWebFluxHandlers(FormsApi api) {
        this(api, Schedulers.boundedElastic());
    }

    /**
     * @param scheduler where the blocking calls run: the application's {@code Scheduler} bean when it defines one, else the elastic scheduler
     */
    public FormsWebFluxHandlers(FormsApi api, Scheduler scheduler) {
        this.api = api;
        this.scheduler = scheduler;
    }

    public Mono<ServerResponse> definition(ServerRequest request) {
        // The principal and the locale (WebFlux's LocaleContextResolver) reach the application's DefinitionCustomizers.
        // With no Accept-Language WebFlux's default resolver answers null where MVC's falls back to the servlet request's
        // locale, the JVM default on a servlet container; the same fallback here, so a customizer that branches on the
        // locale serves one copy (and one ETag) for the same request on both stacks.
        java.util.Locale resolved = request.exchange().getLocaleContext().getLocale();
        java.util.Locale locale = resolved != null ? resolved : java.util.Locale.getDefault();
        return call(request, principal -> api.definition(request.pathVariable("key"), param(request, "public"),
            param(request, "sha256"), request.headers().firstHeader("If-None-Match"), principal, locale));
    }

    public Mono<ServerResponse> translations(ServerRequest request) {
        return call(request, principal -> api.translations(request.pathVariable("key"),
            request.headers().firstHeader("If-None-Match")));
    }

    public Mono<ServerResponse> dataSource(ServerRequest request) {
        return call(request, principal -> api.dataSource(request.pathVariable("id"), param(request, "locale"), principal));
    }

    private Mono<ServerResponse> call(ServerRequest request, Function<Principal, FormsReply> work) {
        return request.principal().map(Optional::<Principal>of).defaultIfEmpty(Optional.empty())
            .flatMap(principal -> Mono.fromCallable(() -> work.apply(principal.orElse(null)))
                .subscribeOn(scheduler))
            .flatMap(FormsWebFluxHandlers::response);
    }

    /**
     * A query parameter as MVC's {@code @RequestParam String} reads it: repeated values are joined with a comma,
     * so {@code ?public=false&public=true} is one bad value on both stacks, not a silent first-wins here.
     */
    private static String param(ServerRequest request, String name) {
        List<String> values = request.queryParams().get(name);
        return values == null || values.isEmpty() ? null : String.join(",", values);
    }

    private static Mono<ServerResponse> response(FormsReply reply) {
        ServerResponse.BodyBuilder builder = ServerResponse.status(HttpStatusCode.valueOf(reply.status()));
        reply.headers().forEach(builder::header);
        if (reply.body() == null) {
            return builder.build();
        }
        return builder.contentType(MediaType.parseMediaType(FormsApi.contentType())).bodyValue(reply.body());
    }
}
