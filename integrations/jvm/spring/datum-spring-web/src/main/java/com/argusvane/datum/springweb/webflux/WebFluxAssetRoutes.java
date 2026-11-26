package com.argusvane.datum.springweb.webflux;

import com.argusvane.datum.web.assets.AssetReply;
import com.argusvane.datum.web.assets.AssetService;
import org.springframework.web.reactive.function.server.RouterFunction;
import org.springframework.web.reactive.function.server.RouterFunctions;
import org.springframework.web.reactive.function.server.ServerResponse;
import reactor.core.publisher.Mono;

/**
 * The two small documents of the asset routes for WebFlux, as a router function (the same routes
 * {@code MvcAssetRoutes} serves): {@code {assets}/host.json} and {@code {assets}/datum-host.js}. The versioned files
 * are not here: Spring's own resource handler serves them behind the Datum gate ({@link WebFluxAssetResources}). The
 * answers are the library's {@link AssetReply}s; this class only writes them out.
 */
public final class WebFluxAssetRoutes {

    private WebFluxAssetRoutes() {
    }

    public static RouterFunction<ServerResponse> routes(AssetService service) {
        // Context-free: router predicates match the path within the application.
        String root = service.routePath();
        return RouterFunctions.route()
            .GET(root + "/host.json", request -> write(service.hostJsonReply()))
            .GET(root + "/datum-host.js", request -> write(service.glueReply()))
            .build();
    }

    private static Mono<ServerResponse> write(AssetReply reply) {
        ServerResponse.BodyBuilder response = ServerResponse.status(reply.status());
        reply.headers().forEach(response::header);
        return response.bodyValue(reply.body());
    }
}
