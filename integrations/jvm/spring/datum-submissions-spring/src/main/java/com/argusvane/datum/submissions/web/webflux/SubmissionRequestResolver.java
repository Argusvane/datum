package com.argusvane.datum.submissions.web.webflux;

import com.argusvane.datum.springweb.webflux.WebFluxRequestViews;
import com.argusvane.datum.submissions.spi.SubmissionRequest;
import java.security.Principal;
import org.springframework.core.MethodParameter;
import org.springframework.web.reactive.BindingContext;
import org.springframework.web.reactive.result.method.HandlerMethodArgumentResolver;
import org.springframework.web.reactive.function.server.ServerRequest;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Mono;

/**
 * The reactive twin of the servlet {@code SubmissionRequestResolver}: handlers call
 * {@link #view(ServerRequest, Principal)}, and an annotated application controller can take a {@code SubmissionRequest}
 * parameter, resolved from the exchange with its principal once the submissions binding registers this.
 */
public final class SubmissionRequestResolver implements HandlerMethodArgumentResolver {

    @Override
    public boolean supportsParameter(MethodParameter parameter) {
        return SubmissionRequest.class.equals(parameter.getParameterType());
    }

    @Override
    public Mono<Object> resolveArgument(MethodParameter parameter, BindingContext bindingContext, ServerWebExchange exchange) {
        ServerRequest request = ServerRequest.create(exchange, java.util.List.of());
        return WebFluxRequestViews.principal(request).map(principal -> (Object) view(request, principal.orElse(null)));
    }

    /** The request view of a functional-endpoint request, with the principal the handler already resolved (null when anonymous). */
    public static SubmissionRequest view(ServerRequest request, Principal principal) {
        return new SubmissionRequest(WebFluxRequestViews.contentType(request), WebFluxRequestViews.headers(request),
            WebFluxRequestViews.remoteAddress(request), principal);
    }
}
