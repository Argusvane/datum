package com.argusvane.datum.springweb.webflux;

import com.argusvane.datum.web.WebSettings;
import com.argusvane.datum.web.error.ErrorMapper;
import com.argusvane.datum.web.error.ErrorResponse;
import com.argusvane.datum.web.json.DatumJsonMapper;
import java.util.Objects;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.MediaType;
import org.springframework.http.server.reactive.ServerHttpResponse;
import org.springframework.security.web.server.ServerAuthenticationEntryPoint;
import org.springframework.security.web.server.authorization.ServerAccessDeniedHandler;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Mono;

/**
 * The WebFlux twin of {@code DatumSecurityResponses} (framework-first): a
 * {@link ServerAccessDeniedHandler} writing 403 {@code access.denied} and a {@link ServerAuthenticationEntryPoint}
 * writing 401 {@code unauthorized} with the application's challenge, both {@code no-store} JSON as {@link ErrorMapper}
 * decides. The application installs them in its {@code SecurityWebFilterChain}
 * ({@code exceptionHandling(e -> e.authenticationEntryPoint(...).accessDeniedHandler(...))}, or behind a
 * {@code DelegatingServerAuthenticationEntryPoint} keyed on {@code DatumExchangeMatchers.all()} when other routes
 * want a login page). A bean of this type exists when Spring Security is on the classpath of a reactive application.
 */
public final class DatumServerSecurityResponses {

    private final ErrorMapper errors;
    private final DatumJsonMapper json;
    private final WebSettings.Csrf csrf;

    /** With the default CSRF names, {@code XSRF-TOKEN} and {@code X-XSRF-TOKEN}. */
    public DatumServerSecurityResponses(ErrorMapper errors, DatumJsonMapper json) {
        this(errors, json, WebSettings.Csrf.defaults());
    }

    /** @param csrf the cookie and header names of {@code datum.web.csrf.*}, which {@link #recipes()} follows */
    public DatumServerSecurityResponses(ErrorMapper errors, DatumJsonMapper json, WebSettings.Csrf csrf) {
        this.errors = Objects.requireNonNull(errors, "errors");
        this.json = Objects.requireNonNull(json, "json");
        this.csrf = Objects.requireNonNull(csrf, "csrf");
    }

    /**
     * The chain lines every application writes the same way, as factories it calls from its own chain. Needs
     * spring-security-config on the class path, which any application with a {@code SecurityWebFilterChain} has; a new
     * object on each call, never a bean.
     */
    public DatumServerSecurityRecipes recipes() {
        return new DatumServerSecurityRecipes(this, csrf);
    }

    /**
     * The 403 {@code access.denied} for a caller the chain refused. A CSRF refusal answers through it only when the
     * application gives it to the CSRF spec as well ({@code .csrf(csrf -> csrf.accessDeniedHandler(...))}): unlike the
     * servlet configurer, Spring Security's WebFlux {@code CsrfSpec} does not take the exception-handling handler, so
     * without that line a missing token is its own plain-text 403.
     */
    public ServerAccessDeniedHandler accessDeniedHandler() {
        return (exchange, denied) -> write(exchange, errors.accessDenied());
    }

    /**
     * The 401 {@code unauthorized} for a caller the chain wants signed in first.
     *
     * @param challenge the {@code WWW-Authenticate} value the application's sign-in uses, or null for none
     */
    public ServerAuthenticationEntryPoint authenticationEntryPoint(String challenge) {
        ErrorResponse answer = errors.unauthorized(challenge);
        return (exchange, failure) -> write(exchange, answer);
    }

    private Mono<Void> write(ServerWebExchange exchange, ErrorResponse answer) {
        ServerHttpResponse response = exchange.getResponse();
        if (response.isCommitted()) {
            return Mono.empty();
        }
        response.setStatusCode(HttpStatusCode.valueOf(answer.status()));
        answer.headers().forEach((name, value) -> response.getHeaders().set(name, value));
        response.getHeaders().setContentType(MediaType.parseMediaType(answer.contentType()));
        byte[] body = answer.bodyBytes(json.mapper());
        return response.writeWith(Mono.just(response.bufferFactory().wrap(body)));
    }
}
