package com.argusvane.datum.springweb.webflux;

import com.argusvane.datum.web.assets.AssetReply;
import com.argusvane.datum.web.assets.AssetService;
import java.util.List;
import java.util.Optional;
import org.springframework.core.Ordered;
import org.springframework.core.io.ClassPathResource;
import org.springframework.core.io.Resource;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.server.reactive.ServerHttpRequest;
import org.springframework.web.server.WebFilter;
import org.springframework.web.server.WebFilterChain;
import org.springframework.http.CacheControl;
import org.springframework.web.reactive.config.ResourceHandlerRegistry;
import org.springframework.web.reactive.config.WebFluxConfigurer;
import org.springframework.web.reactive.resource.ResourceResolver;
import org.springframework.web.reactive.resource.ResourceResolverChain;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Scheduler;
import reactor.core.scheduler.Schedulers;

/**
 * The versioned asset files on WebFlux's own resource handler (framework-first), the reactive twin of
 * {@code MvcAssetResources}: the framework finds and writes the file, sets its media type, validators and the
 * immutable {@code Cache-Control} of the registration; the Datum gate ({@link AssetService#gate}) decides, as a
 * {@link ResourceResolver} first in the chain, what may be asked for, on exactly the string the framework resolves.
 *
 * <p>The same class is a {@link WebFilter} (after Spring Security's chain) that runs the gate on the raw request URI and
 * checks that a file which passes is on the class path, answering any miss with a bare 404 that no cache keeps, the same
 * wire as MVC's interceptor (so a client or CDN rule sees one answer whichever stack runs). The class-path lookup is
 * blocking I/O, so it and the chain below the gate run on the bounded-elastic scheduler, off the event loop; the gate
 * itself reads nothing (the omitted-feature list is loaded when the service is built).
 *
 * <p>{@code host.json} and the glue are the router function's ({@link WebFluxAssetRoutes}), which is asked first.
 */
public final class WebFluxAssetResources implements WebFluxConfigurer, WebFilter, Ordered {

    private final AssetService service;
    private final Scheduler scheduler;

    public WebFluxAssetResources(AssetService service) {
        this(service, Schedulers.boundedElastic());
    }

    /** @param scheduler where the class path lookups run: the application's {@code Scheduler} bean when it defines one */
    public WebFluxAssetResources(AssetService service, Scheduler scheduler) {
        this.service = service;
        this.scheduler = scheduler;
    }

    @Override
    public void addResourceHandlers(ResourceHandlerRegistry registry) {
        if (!service.assets().enabled()) {
            return;
        }
        registry.addResourceHandler(service.routePath() + "/**")
            .addResourceLocations(AssetService.RESOURCE_LOCATION)
            .setCacheControl(CacheControl.maxAge(service.cachePeriod()).cachePublic().immutable())
            .resourceChain(false)
            .addResolver(new Gate(service, scheduler));
    }

    @Override
    public int getOrder() {
        // After Spring Security's WebFilterChainProxy (-100), so its decisions come first.
        return 0;
    }

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, WebFilterChain chain) {
        if (!service.assets().enabled()) {
            return chain.filter(exchange);
        }
        ServerHttpRequest request = exchange.getRequest();
        String raw = request.getURI().getRawPath();
        String context = request.getPath().contextPath().value();
        String path = raw.startsWith(context) ? raw.substring(context.length()) : raw;
        String root = service.routePath();
        if (!path.startsWith(root + "/") || path.equals(root + "/host.json") || path.equals(root + "/datum-host.js")) {
            return chain.filter(exchange);
        }
        Optional<String> file = service.gate(path.substring(root.length() + 1));
        if (file.isEmpty()) {
            return refuse(exchange);
        }
        return Mono.fromCallable(() -> new ClassPathResource(AssetService.LOCATION + file.get()).isReadable())
            .subscribeOn(scheduler)
            .flatMap(found -> found ? chain.filter(exchange) : refuse(exchange));
    }

    private Mono<Void> refuse(ServerWebExchange exchange) {
        AssetReply refusal = service.notFoundReply();
        exchange.getResponse().setStatusCode(HttpStatusCode.valueOf(refusal.status()));
        refusal.headers().forEach((name, value) -> exchange.getResponse().getHeaders().set(name, value));
        return exchange.getResponse().setComplete();
    }

    /** The authority: refuses what the gate refuses, and hands the framework the path below the build id. */
    static final class Gate implements ResourceResolver {

        private final AssetService service;
        private final Scheduler scheduler;

        Gate(AssetService service, Scheduler scheduler) {
            this.service = service;
            this.scheduler = scheduler;
        }

        @Override
        public Mono<Resource> resolveResource(ServerWebExchange exchange, String requestPath, List<? extends Resource> locations,
                                              ResourceResolverChain chain) {
            return service.gate(requestPath)
                .map(file -> Mono.defer(() -> chain.resolveResource(exchange, file, locations)).subscribeOn(scheduler))
                .orElse(Mono.empty());
        }

        @Override
        public Mono<String> resolveUrlPath(String resourcePath, List<? extends Resource> locations, ResourceResolverChain chain) {
            // Datum builds no URLs through the framework's resource URL provider; nothing is offered.
            return Mono.empty();
        }
    }
}
