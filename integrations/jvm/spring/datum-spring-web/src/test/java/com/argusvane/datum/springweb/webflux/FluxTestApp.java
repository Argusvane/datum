package com.argusvane.datum.springweb.webflux;

import static org.springframework.web.reactive.function.server.RouterFunctions.route;

import com.argusvane.datum.springweb.spring.DatumProperties;
import com.argusvane.datum.springweb.support.Failures;
import com.argusvane.datum.web.assets.WithheldAssets;
import com.argusvane.datum.web.json.DatumJsonMapper;
import java.util.Map;
import org.springframework.boot.SpringBootConfiguration;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.web.reactive.function.server.RouterFunction;
import org.springframework.web.reactive.function.server.ServerResponse;

/** A WebFlux application with Datum-style router functions (registered as Datum routes) and one route of its own. */
@SpringBootConfiguration
@EnableAutoConfiguration
public class FluxTestApp {

    @Bean
    WithheldAssets builderFilesWithheld() {
        return path -> path.equals("datum-builder.js");
    }

    @Bean
    RouterFunction<ServerResponse> datumTestRoutes(DatumRouteRegistry routes, DatumProperties properties, DatumJsonMapper json) {
        routes.register("/test/**");
        long cap = properties.web().api().maxBodySize().toBytes();
        return route()
            .GET("/test/throw/{kind}", request -> {
                throw Failures.of(request.pathVariable("kind"));
            })
            .GET("/test/hidden/x", request -> ServerResponse.ok().bodyValue("hidden"))
            .POST("/test/echo", request -> WebFluxBodies.readJson(request.exchange().getRequest(), cap, json)
                .flatMap(node -> ServerResponse.ok().bodyValue(Map.of("size", node.size()))))
            .GET("/app/boom", request -> {
                throw new IllegalStateException("the application's own failure");
            })
            .build();
    }

    private static org.springframework.web.reactive.function.server.RouterFunctions.Builder route() {
        return org.springframework.web.reactive.function.server.RouterFunctions.route();
    }
}
