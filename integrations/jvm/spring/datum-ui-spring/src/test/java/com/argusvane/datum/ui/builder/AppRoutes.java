package com.argusvane.datum.ui.builder;

import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication.Type;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.reactive.function.server.RouterFunction;
import org.springframework.web.reactive.function.server.RouterFunctions;
import org.springframework.web.reactive.function.server.ServerResponse;

/**
 * An application's own route beside the builder's: {@code DELETE /api/forms/{key}}, which Datum does not serve, as an
 * MVC controller or a WebFlux router function. The builder must leave it to the application on both stacks (a path-wide 405 would
 * take it on WebFlux).
 */
@Configuration(proxyBeanMethods = false)
public class AppRoutes {

    @Bean
    @ConditionalOnWebApplication(type = Type.SERVLET)
    AppDeleteController appDeleteController() {
        return new AppDeleteController();
    }

    @Bean
    @ConditionalOnWebApplication(type = Type.REACTIVE)
    RouterFunction<ServerResponse> appDeleteRoute() {
        return RouterFunctions.route().DELETE("/api/forms/{key}", request -> ServerResponse.noContent().header("X-App", "deleted").build()).build();
    }
}
