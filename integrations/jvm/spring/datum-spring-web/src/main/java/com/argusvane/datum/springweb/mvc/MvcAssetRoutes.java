package com.argusvane.datum.springweb.mvc;

import com.argusvane.datum.web.assets.AssetReply;
import com.argusvane.datum.web.assets.AssetService;
import org.springframework.web.servlet.function.RouterFunction;
import org.springframework.web.servlet.function.RouterFunctions;
import org.springframework.web.servlet.function.ServerResponse;

/**
 * The two small documents of the asset routes for Spring MVC, as a router function (the same routes
 * {@code WebFluxAssetRoutes} serves): {@code {assets}/host.json} and {@code {assets}/datum-host.js}. The versioned
 * files are not here: Spring's own resource handler serves them behind the Datum gate ({@link MvcAssetResources}).
 * The answers are the library's {@link AssetReply}s; this class only writes them out.
 */
public final class MvcAssetRoutes {

    private MvcAssetRoutes() {
    }

    public static RouterFunction<ServerResponse> routes(AssetService service) {
        // Context-free: router predicates match the path within the application.
        String root = service.routePath();
        return RouterFunctions.route()
            .GET(root + "/host.json", request -> write(service.hostJsonReply()))
            .GET(root + "/datum-host.js", request -> write(service.glueReply()))
            .build();
    }

    private static ServerResponse write(AssetReply reply) {
        ServerResponse.BodyBuilder response = ServerResponse.status(reply.status());
        reply.headers().forEach(response::header);
        return response.body(reply.body());
    }
}
