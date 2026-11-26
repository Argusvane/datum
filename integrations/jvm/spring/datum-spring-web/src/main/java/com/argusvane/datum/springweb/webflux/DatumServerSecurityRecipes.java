package com.argusvane.datum.springweb.webflux;

import com.argusvane.datum.web.WebSettings;
import java.util.List;
import java.util.Objects;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.web.server.ServerHttpSecurity;
import org.springframework.security.web.server.DelegatingServerAuthenticationEntryPoint;
import org.springframework.security.web.server.authorization.ServerWebExchangeDelegatingServerAccessDeniedHandler;
import org.springframework.security.web.server.csrf.CookieServerCsrfTokenRepository;
import org.springframework.security.web.server.csrf.CsrfToken;
import org.springframework.security.web.server.csrf.ServerCsrfTokenRequestAttributeHandler;
import org.springframework.security.web.server.util.matcher.ServerWebExchangeMatcher;
import org.springframework.web.server.WebFilter;
import reactor.core.publisher.Mono;

/**
 * The WebFlux twin of {@code DatumSecurityRecipes}: the lines every application
 * with a {@code SecurityWebFilterChain} writes the same way, as opt-in factories it calls from its own chain, never
 * beans and never a customizer Datum applies for it. Get one from {@link DatumServerSecurityResponses#recipes()}:
 *
 * <pre>{@code
 * DatumServerSecurityRecipes recipes = responses.recipes();
 * http
 *     .csrf(recipes.csrfForGlue(builderWrites))
 *     .addFilterAfter(recipes.csrfCookieFilter(), SecurityWebFiltersOrder.CSRF)
 *     .exceptionHandling(recipes.exceptionHandling(datum.all(), "Basic realm=\"Datum forms\""));
 * }</pre>
 *
 * <p>Unlike the servlet configurer, WebFlux's {@code CsrfSpec} does not take the exception-handling denied handler, so
 * {@link #csrfForGlue} gives it Datum's own: a missing token answers {@code access.denied} JSON rather than a plain-text 403.
 */
public final class DatumServerSecurityRecipes {

    private final DatumServerSecurityResponses responses;
    private final WebSettings.Csrf csrf;

    DatumServerSecurityRecipes(DatumServerSecurityResponses responses, WebSettings.Csrf csrf) {
        this.responses = Objects.requireNonNull(responses, "responses");
        this.csrf = Objects.requireNonNull(csrf, "csrf");
    }

    /**
     * Datum's refusals on Datum's routes only (401 {@code unauthorized} with {@code challenge}, 403 {@code access.denied}),
     * Spring Security's own answers elsewhere.
     *
     * @param routes usually {@code DatumExchangeMatchers#all()}
     * @param challenge the {@code WWW-Authenticate} value the application's sign-in uses, or null for none
     */
    public Customizer<ServerHttpSecurity.ExceptionHandlingSpec> exceptionHandling(ServerWebExchangeMatcher routes, String challenge) {
        Objects.requireNonNull(routes, "routes");
        return exceptions -> exceptions
            .authenticationEntryPoint(new DelegatingServerAuthenticationEntryPoint(List.of(
                new DelegatingServerAuthenticationEntryPoint.DelegateEntry(routes, responses.authenticationEntryPoint(challenge)))))
            .accessDeniedHandler(new ServerWebExchangeDelegatingServerAccessDeniedHandler(List.of(
                new ServerWebExchangeDelegatingServerAccessDeniedHandler.DelegateEntry(routes, responses.accessDeniedHandler()))));
    }

    /** Datum's refusals for every route of the chain, for an application whose chain serves nothing else. */
    public Customizer<ServerHttpSecurity.ExceptionHandlingSpec> exceptionHandling(String challenge) {
        return exceptions -> exceptions
            .authenticationEntryPoint(responses.authenticationEntryPoint(challenge))
            .accessDeniedHandler(responses.accessDeniedHandler());
    }

    /** The CSRF token repository, request handler and denied handler the page glue reads, named by {@code datum.web.csrf.*}. */
    public Customizer<ServerHttpSecurity.CsrfSpec> csrfForGlue() {
        return spec -> {
            CookieServerCsrfTokenRepository repository = CookieServerCsrfTokenRepository.withHttpOnlyFalse();
            repository.setCookieName(csrf.cookieName());
            repository.setHeaderName(csrf.headerName());
            spec.csrfTokenRepository(repository)
                .csrfTokenRequestHandler(new ServerCsrfTokenRequestAttributeHandler())
                .accessDeniedHandler(responses.accessDeniedHandler());
        };
    }

    /** As {@link #csrfForGlue()}, with CSRF required only where {@code requireOn} matches (a builder's writes, say). */
    public Customizer<ServerHttpSecurity.CsrfSpec> csrfForGlue(ServerWebExchangeMatcher requireOn) {
        Objects.requireNonNull(requireOn, "requireOn");
        Customizer<ServerHttpSecurity.CsrfSpec> base = csrfForGlue();
        return spec -> {
            base.customize(spec);
            spec.requireCsrfProtectionMatcher(requireOn);
        };
    }

    /** Add it after the CSRF filter: it loads the deferred token so the repository writes its cookie on this response. */
    public WebFilter csrfCookieFilter() {
        return (exchange, chain) -> {
            Mono<CsrfToken> token = exchange.getAttribute(CsrfToken.class.getName());
            return token == null ? chain.filter(exchange) : token.then(chain.filter(exchange));
        };
    }
}
